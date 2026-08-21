// Serves track audio bytes for the in-browser gapless album player
// (AlbumPlayer.tsx via /api/audio/[trackId]). Two playback formats:
//
//   - mp3 / aac: the ORIGINAL file, streamed byte-for-byte. Both codecs
//     decode natively in every browser's Web Audio, and re-encoding a lossy
//     format is a straight quality loss for zero benefit — so these are
//     passed through untouched (see resolvePlaybackFormat).
//   - alac / flac: neither decodes natively outside Safari (ALAC) or at all
//     via decodeAudioData in most engines, so these are remuxed to FLAC via
//     `ffmpeg -i <in> -map 0:a:0 -c:a flac -f flac -`. This is a
//     lossless-to-lossless re-encode (bit-identical PCM, different
//     container/entropy coding) — not the quality-losing transcode this
//     library otherwise refuses to do (see PLAN.md "Future: playback").
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
import path from "node:path";
import { prisma } from "@/lib/db";

const execFileAsync = promisify(execFile);

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
 * through ffmpeg; null means unplayable (DRM, unknown, or no codec at all).
 */
export function resolvePlaybackFormat(
  codec: string | null | undefined,
): { kind: "passthrough"; contentType: string } | { kind: "flac" } | null {
  switch ((codec ?? "").toLowerCase()) {
    case "mp3":
      return { kind: "passthrough", contentType: "audio/mpeg" };
    case "aac":
      return { kind: "passthrough", contentType: "audio/mp4" };
    case "alac":
    case "flac":
      return { kind: "flac" };
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

// Spawn a child process and hand back its stdout as a Web ReadableStream.
// `Readable.toWeb` wires up errors that arrive *on the stream itself*, but a
// child that fails to spawn at all (e.g. `docker` missing from PATH) only
// emits `error` on the ChildProcess — forward that onto stdout too, so a
// spawn failure surfaces as a stream error (caught client-side as a failed
// fetch) instead of a request that hangs forever.
function spawnToWebStream(cmd: string, args: string[]): ReadableStream<Uint8Array> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", (err) => child.stdout.destroy(err));
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

function fileToWebStream(readStream: ReadStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(readStream) as ReadableStream<Uint8Array>;
}

async function flacRemuxStream(absPath: string, musicRoot: string): Promise<ReadableStream<Uint8Array> | null> {
  const hasLocal = await detectLocalFfmpeg();
  if (hasLocal) {
    return spawnToWebStream("ffmpeg", ["-i", absPath, ...FLAC_REMUX_ARGS]);
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) return null;

  const rel = path.relative(musicRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const containerIn = `/probe-root/${rel.split(path.sep).join("/")}`;

  return spawnToWebStream("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/ffmpeg",
    "-v",
    `${musicRoot}:/probe-root:ro`,
    dockerImage,
    "-i",
    containerIn,
    ...FLAC_REMUX_ARGS,
  ]);
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
export async function getTrackAudio(trackId: number): Promise<TrackAudio | null> {
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    include: { album: { select: { owned: true } } },
  });
  if (!track || !track.album?.owned) return null;

  const format = resolvePlaybackFormat(track.codec);
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

  const stream = await flacRemuxStream(absPath, musicRoot);
  if (!stream) return null;
  return { stream, contentType: "audio/flac", filename: withFlacExtension(track.fileName) };
}
