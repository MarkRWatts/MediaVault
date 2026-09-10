// Serves track audio bytes for the in-browser gapless album player
// (AlbumPlayer.tsx via /api/audio/[trackId]). Three playback formats:
//
//   - mp3 / aac: the ORIGINAL file, streamed byte-for-byte. Both codecs
//     decode natively in every browser's Web Audio, and re-encoding a lossy
//     format is a straight quality loss for zero benefit — so these are
//     passed through untouched (see resolvePlaybackFormat).
//   - alac / flac, on the LAN: neither decodes natively outside Safari
//     (ALAC) or at all via decodeAudioData in most engines, so these are
//     remuxed to FLAC via `ffmpeg -i <in> -map 0:a:0 -c:a flac -f flac -`.
//     This is a lossless-to-lossless re-encode (bit-identical PCM, different
//     container/entropy coding) — not the quality-losing transcode this
//     library otherwise refuses to do (see PLAN.md "Future: playback").
//   - alac / flac, off the LAN (preferLossyRemote): the player has to fetch
//     the *entire* file before decodeAudioData can start (no progressive
//     decode API — see player-engine.ts), and a lossless remux of a
//     multi-minute track can run tens of MB; over a slow/high-latency
//     mobile connection that can take long enough to look like silent,
//     stuck playback (see the off-LAN iPhone report this was added for,
//     2026-09-10). So off-LAN, these get a 256kbps AAC remux instead — a
//     5-10x smaller download — matching VideoPlayer's off-LAN 720p default
//     (src/lib/request-network.ts). LAN playback stays fully lossless.
//
// Mirrors ffprobe.ts / cover-art.ts's local-ffmpeg-vs-docker fallback, but
// *streams* ffmpeg's stdout straight into the HTTP response instead of
// buffering to a temp file — a multi-minute lossless track can run tens of
// MB, and a route handler can hand back a ReadableStream directly (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
// "Streaming"), so there's no need to wait for the whole re-encode (or a
// scratch dir) before the browser starts receiving bytes.
//
// DRM (.m4p, codec "drm"), unrecognised codecs, and any track whose file
// can't be resolved all return null — the route turns that into a 404.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, type ReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audioSemaphore } from "@/lib/semaphore";

const execFileAsync = promisify(execFile);

/** getTrackAudio's answer when every remux slot is taken (see
 *  src/lib/semaphore.ts): the route turns this into a 503 + Retry-After
 *  and the player tries again, rather than this process spawning an
 *  unbounded number of ffmpegs. Passthrough tracks never hit this. */
export const AUDIO_BUSY = Symbol("audio-busy");

export interface TrackAudio {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** Suggested filename (extension already matches contentType) — not used
   *  for a Content-Disposition header (playback is inline), kept for
   *  callers that want it. */
  filename: string;
}

/**
 * Pure codec -> playback-format decision, split out from getTrackAudio so
 * it's testable without a database or ffmpeg. "passthrough" means serve the
 * original bytes as-is (with the given Content-Type); "flac" means remux
 * losslessly through ffmpeg; "aac-remote" means remux to a small lossy AAC
 * (only offered for alac/flac, and only when preferLossyRemote is set —
 * see the header comment); null means unplayable (DRM, unknown, or no
 * codec at all).
 */
export function resolvePlaybackFormat(
  codec: string | null | undefined,
  opts?: { preferLossyRemote?: boolean },
): { kind: "passthrough"; contentType: string } | { kind: "flac" } | { kind: "aac-remote" } | null {
  switch ((codec ?? "").toLowerCase()) {
    case "mp3":
      return { kind: "passthrough", contentType: "audio/mpeg" };
    case "aac":
      return { kind: "passthrough", contentType: "audio/mp4" };
    case "alac":
    case "flac":
      return opts?.preferLossyRemote ? { kind: "aac-remote" } : { kind: "flac" };
    default:
      return null; // drm | unknown | null
  }
}

// Swap a file's extension for ".flac" — used for the filename we hand back
// when remuxing (the source is .m4a/.flac, the output is always .flac).
function withFlacExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "") + ".flac";
}

let hasLocalFfmpegPromise: Promise<boolean> | null = null;
function detectLocalFfmpeg(): Promise<boolean> {
  if (!hasLocalFfmpegPromise) {
    hasLocalFfmpegPromise = execFileAsync("ffmpeg", ["-version"])
      .then(() => true)
      .catch(() => false);
  }
  return hasLocalFfmpegPromise;
}

const FLAC_REMUX_ARGS = ["-map", "0:a:0", "-c:a", "flac", "-f", "flac", "-"];
// WAV fallback for engines whose decodeAudioData rejects FLAC (Safari's
// CoreAudio does, with a literal null error). 16-bit PCM matches the
// library's source depth, so this is still lossless.
const WAV_ARGS = ["-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "wav"];
// Off-LAN lossy fallback for alac/flac (see header comment). Two earlier
// attempts before this one:
//   1. Fragmented mp4 (movflags frag_keyframe+empty_moov), so it could
//      stream straight from ffmpeg's stdout like FLAC_REMUX_ARGS does —
//      decodeAudioData rejected it outright, confirmed in Chromium too,
//      not just Safari.
//   2. Plain (non-fragmented) mp4 through a temp file (tempFileConvertStream,
//      same reason WAV needs one — a seekable output for the moov atom) —
//      decodes fine, but the whole encode (tens of seconds for a long
//      track on the VM's older 4-core Xeon) has to finish before a single
//      byte reaches the client, which just traded a correctness bug for a
//      "why is this slow" one.
// ADTS is AAC's own self-framing bitstream format (no container-level
// index/seek table to finalize), so it's both streamable from stdout AND,
// per Apple's own use of it for HLS audio, expected to decode on Safari —
// confirmed decoding correctly in Chromium; NOT yet confirmed on an actual
// iPhone. If it turns out Safari rejects this too, the existing WAV retry
// (fetchAndDecode's catch) is still there as a safety net — worth knowing
// that a bad outcome there means a giant uncompressed download, exactly
// the failure mode this whole off-LAN path exists to avoid.
const AAC_REMOTE_ARGS = ["-map", "0:a:0", "-c:a", "aac", "-b:a", "256k", "-f", "adts", "-"];

// Spawn a child process and hand back its stdout as a Web ReadableStream.
// `Readable.toWeb` wires up errors that arrive *on the stream itself*, but a
// child that fails to spawn at all (e.g. `docker` missing from PATH) only
// emits `error` on the ChildProcess — forward that onto stdout too, so a
// spawn failure surfaces as a stream error (caught client-side as a failed
// fetch) instead of a request that hangs forever.
function spawnToWebStream(cmd: string, args: string[], onDone: () => void = () => {}): ReadableStream<Uint8Array> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", (err) => {
    child.stdout.destroy(err);
    onDone();
  });
  child.on("close", onDone);
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

function fileToWebStream(readStream: ReadStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(readStream) as ReadableStream<Uint8Array>;
}

// Shared by flacRemuxStream and aacRemoteStream — both just an ffmpeg
// filter chain streamed straight from stdout, differing only in the output
// args (see FLAC_REMUX_ARGS / AAC_REMOTE_ARGS above).
async function remuxStream(
  absPath: string,
  musicRoot: string,
  outputArgs: string[],
  onDone: () => void,
): Promise<ReadableStream<Uint8Array> | null> {
  const hasLocal = await detectLocalFfmpeg();
  if (hasLocal) {
    return spawnToWebStream("ffmpeg", ["-i", absPath, ...outputArgs], onDone);
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) return null;

  const rel = path.relative(musicRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const containerIn = `/probe-root/${rel.split(path.sep).join("/")}`;

  return spawnToWebStream(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/ffmpeg",
      "-v",
      `${musicRoot}:/probe-root:ro`,
      dockerImage,
      "-i",
      containerIn,
      ...outputArgs,
    ],
    onDone,
  );
}

function flacRemuxStream(absPath: string, musicRoot: string, onDone: () => void) {
  return remuxStream(absPath, musicRoot, FLAC_REMUX_ARGS, onDone);
}

function aacRemoteStream(absPath: string, musicRoot: string, onDone: () => void) {
  return remuxStream(absPath, musicRoot, AAC_REMOTE_ARGS, onDone);
}

// WAV can't be streamed straight from ffmpeg's stdout: a non-seekable
// output leaves the RIFF size fields as placeholders, which strict
// decoders (Safari) reject. Convert to a temp file first — the header
// gets written correctly on close — then stream that, unlinking once the
// response ends. The slot (audioSemaphore) is only held for the
// conversion itself; the caller releases it before this returns.
async function tempFileConvertStream(
  absPath: string,
  musicRoot: string,
  args: string[],
  outFileName: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediavault-audio-"));
  const tmpOut = path.join(tmpDir, outFileName);
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  try {
    if (await detectLocalFfmpeg()) {
      await execFileAsync("ffmpeg", ["-y", "-i", absPath, ...args, tmpOut], { maxBuffer: 1024 * 1024 });
    } else {
      const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
      if (!dockerImage) {
        await cleanup();
        return null;
      }
      const rel = path.relative(musicRoot, absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        await cleanup();
        return null;
      }
      const containerIn = `/probe-root/${rel.split(path.sep).join("/")}`;
      await execFileAsync("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "/ffmpeg",
        "-v",
        `${musicRoot}:/probe-root:ro`,
        "-v",
        `${tmpDir}:/out`,
        dockerImage,
        "-y",
        "-i",
        containerIn,
        ...args,
        `/out/${outFileName}`,
      ]);
    }
  } catch {
    await cleanup();
    return null;
  }

  const readStream = createReadStream(tmpOut);
  readStream.once("close", cleanup);
  readStream.once("error", cleanup);
  return fileToWebStream(readStream);
}

function wavConvertStream(absPath: string, musicRoot: string) {
  return tempFileConvertStream(absPath, musicRoot, WAV_ARGS, "out.wav");
}

/**
 * Resolve one Track to playable audio bytes. Looks up the Track joined with
 * its Album (both so a dangling/orphaned track can't be served, and so an
 * album that's been flipped to owned=false — no files on disk — is refused
 * even if a stale Track row somehow remained). Returns null for: unknown
 * track id, unowned album, unset MUSIC_PATH, a codec that isn't playable
 * (resolvePlaybackFormat), a file that's missing on disk, or (for the FLAC
 * path) no local ffmpeg and no FFPROBE_DOCKER_IMAGE fallback configured.
 */
export async function getTrackAudio(
  trackId: number,
  opts?: { wav?: boolean; preferLossyRemote?: boolean },
): Promise<TrackAudio | null | typeof AUDIO_BUSY> {
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    include: { album: { select: { owned: true } } },
  });
  if (!track || !track.album?.owned) return null;

  const format = resolvePlaybackFormat(track.codec, { preferLossyRemote: opts?.preferLossyRemote });
  if (!format) return null;

  const musicPath = process.env.MUSIC_PATH;
  if (!musicPath) return null;

  const musicRoot = path.resolve(musicPath);
  const absPath = path.resolve(musicRoot, track.filePath);
  // Path-traversal guard, same shape as /api/cover — filePath comes from the
  // scanner's own directory walk so this should never trip, but a Track row
  // is untrusted input as far as this route is concerned.
  if (absPath !== musicRoot && !absPath.startsWith(musicRoot + path.sep)) return null;

  try {
    await fs.access(absPath);
  } catch {
    return null;
  }

  if (format.kind === "passthrough") {
    return {
      stream: fileToWebStream(createReadStream(absPath)),
      contentType: format.contentType,
      filename: track.fileName,
    };
  }

  // Everything below spawns ffmpeg — one slot per remux, none queued.
  const release = audioSemaphore().tryAcquire();
  if (!release) return AUDIO_BUSY;

  if (opts?.wav) {
    // The conversion runs to completion into a temp file before anything is
    // streamed, so the slot is only held for the encode itself.
    let wavStream: ReadableStream<Uint8Array> | null;
    try {
      wavStream = await wavConvertStream(absPath, musicRoot);
    } finally {
      release();
    }
    if (!wavStream) return null;
    return {
      stream: wavStream,
      contentType: "audio/wav",
      filename: track.fileName.replace(/\.[^./\\]+$/, "") + ".wav",
    };
  }

  // Streams straight from ffmpeg's stdout, same as FLAC below: ADTS is
  // self-framing (see AAC_REMOTE_ARGS), so unlike the mp4 attempts that
  // came before it, nothing needs a seekable temp file to finalize —
  // playback can start as soon as the first bytes arrive instead of
  // waiting out the whole encode.
  if (format.kind === "aac-remote") {
    const stream = await aacRemoteStream(absPath, musicRoot, release);
    if (!stream) {
      release();
      return null;
    }
    return {
      stream,
      contentType: "audio/aac",
      filename: track.fileName.replace(/\.[^./\\]+$/, "") + ".aac",
    };
  }

  const stream = await flacRemuxStream(absPath, musicRoot, release);
  if (!stream) {
    release();
    return null;
  }
  return { stream, contentType: "audio/flac", filename: withFlacExtension(track.fileName) };
}
