// Serves track audio for the in-browser gapless player (player-engine.ts
// via /api/audio/[trackId]) as a raw PCM stream: ffmpeg decodes whatever
// the file is (mp3, aac, alac, flac) and writes interleaved little-endian
// samples straight to stdout, which is piped into the HTTP response as it
// is produced. No container, no framing — see src/lib/pcm-chunks.ts for
// the client side.
//
// History, and why PCM rather than something smaller: this used to serve
// the original bytes for mp3/aac and an ffmpeg FLAC remux for alac/flac
// (plus an AAC remux off-LAN and a WAV fallback for Safari, whose
// decodeAudioData rejects FLAC). All of those go through decodeAudioData,
// which needs the *complete* file before it will decode a single sample —
// so even on a gigabit LAN every track began with a visible multi-second
// download (twice, on Safari: the FLAC it couldn't decode, then the WAV).
// Raw PCM is playable from the first byte, so the engine starts a track
// after the first half-second of samples arrives — ~100 ms after the
// click on the LAN, with ffmpeg's own start-up as the only latency.
// Bandwidth is ~1.4 Mbit/s for 16-bit 44.1 kHz stereo; fine on 4G/5G.
//
// Sample rate: the client asks for its AudioContext's own rate (?rate=)
// so ffmpeg does any resampling (swresample, high quality, one pass) and
// every AudioBuffer matches the context exactly — Web Audio then never
// resamples per-source, which is what keeps the half-second chunk joins
// sample-accurate. Bit depth follows the source: 16-bit for the library's
// CD-quality bulk, 24-bit for the handful of hi-res tracks, so this is
// still lossless end-to-end on the LAN (a resample is the one exception,
// and only when the device's context rate differs from the file's).
//
// Mirrors ffprobe.ts / cover-art.ts's local-ffmpeg-vs-docker fallback.
// DRM (.m4p, codec "drm"), unrecognised codecs, and any track whose file
// can't be resolved all return null — the route turns that into a 404.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audioSemaphore } from "@/lib/semaphore";
import type { PcmStreamFormat } from "@/lib/pcm-chunks";

const execFileAsync = promisify(execFile);

/** getTrackAudio's answer when every ffmpeg slot is taken (see
 *  src/lib/semaphore.ts): the route turns this into a 503 + Retry-After
 *  and the player tries again, rather than this process spawning an
 *  unbounded number of decoders. */
export const AUDIO_BUSY = Symbol("audio-busy");

export interface TrackAudio {
  stream: ReadableStream<Uint8Array>;
  format: PcmStreamFormat;
  /** What the whole stream should come to, from the DB's duration estimate
   *  — for a progress percentage, not exact. Null if the duration is unknown. */
  estimatedBytes: number | null;
}

/** Output rates a client may ask for — the set of AudioContext rates real
 *  devices run at. Anything else falls back to the file's own rate. */
export const PCM_OUTPUT_RATES = new Set([44100, 48000, 88200, 96000, 176400, 192000]);

const PCM_CHANNELS = 2;

/**
 * Pure codec -> output-format decision, split out from getTrackAudio so
 * it's testable without a database or ffmpeg. Every decodable codec comes
 * out as PCM; null means unplayable (DRM, unknown, or no codec at all).
 * `requestedRate` wins when it's one of PCM_OUTPUT_RATES, else the track's
 * own rate (44.1 kHz if unprobed); bits follow the source depth.
 */
export function resolvePcmFormat(
  codec: string | null | undefined,
  track: { sampleRate: number | null; bitDepth: number | null },
  requestedRate?: number | null,
): PcmStreamFormat | null {
  switch ((codec ?? "").toLowerCase()) {
    case "mp3":
    case "aac":
    case "alac":
    case "flac":
      break;
    default:
      return null; // drm | unknown | null
  }
  const sampleRate =
    requestedRate != null && PCM_OUTPUT_RATES.has(requestedRate) ? requestedRate : (track.sampleRate ?? 44100);
  const bits: 16 | 24 = (track.bitDepth ?? 16) > 16 ? 24 : 16;
  return { sampleRate, channels: PCM_CHANNELS, bits };
}

/** Bytes a track of `durationSecs` comes to in this format. */
export function estimatePcmBytes(durationSecs: number | null, format: PcmStreamFormat): number | null {
  if (durationSecs == null || !Number.isFinite(durationSecs) || durationSecs <= 0) return null;
  return Math.round(durationSecs * format.sampleRate) * format.channels * (format.bits / 8);
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

function pcmOutputArgs(format: PcmStreamFormat): string[] {
  const codec = format.bits === 24 ? "pcm_s24le" : "pcm_s16le";
  const muxer = format.bits === 24 ? "s24le" : "s16le";
  return ["-map", "0:a:0", "-ar", String(format.sampleRate), "-ac", String(format.channels), "-c:a", codec, "-f", muxer, "-"];
}

// Spawn a child process and hand back its stdout as a Web ReadableStream.
// `Readable.toWeb` wires up errors that arrive *on the stream itself*, but a
// child that fails to spawn at all (e.g. `docker` missing from PATH) only
// emits `error` on the ChildProcess — forward that onto stdout too, so a
// spawn failure surfaces as a stream error (caught client-side as a failed
// fetch) instead of a request that hangs forever. When the client goes
// away mid-track (skip, queue edit, tab closed) Next cancels the web
// stream, which destroys stdout — kill the child then rather than leaving
// a decoder blocked on a pipe nobody reads.
function spawnToWebStream(cmd: string, args: string[], onDone: () => void = () => {}): ReadableStream<Uint8Array> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", (err) => {
    child.stdout.destroy(err);
    onDone();
  });
  child.on("close", onDone);
  child.stdout.on("close", () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

async function pcmStream(
  absPath: string,
  musicRoot: string,
  format: PcmStreamFormat,
  onDone: () => void,
): Promise<ReadableStream<Uint8Array> | null> {
  const inputArgs = ["-nostdin", "-v", "error", "-i"];
  const outputArgs = pcmOutputArgs(format);
  const hasLocal = await detectLocalFfmpeg();
  if (hasLocal) {
    return spawnToWebStream("ffmpeg", [...inputArgs, absPath, ...outputArgs], onDone);
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) return null;

  const rel = path.relative(musicRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const containerIn = `/probe-root/${rel.split(path.sep).join("/")}`;

  return spawnToWebStream(
    "docker",
    ["run", "--rm", "--entrypoint", "/ffmpeg", "-v", `${musicRoot}:/probe-root:ro`, dockerImage, ...inputArgs, containerIn, ...outputArgs],
    onDone,
  );
}

/**
 * Resolve one Track to a PCM stream. Looks up the Track joined with its
 * Album (both so a dangling/orphaned track can't be served, and so an
 * album that's been flipped to owned=false — no files on disk — is refused
 * even if a stale Track row somehow remained). Returns null for: unknown
 * track id, unowned album, unset MUSIC_PATH, a codec that isn't playable
 * (resolvePcmFormat), a file that's missing on disk, or no local ffmpeg and
 * no FFPROBE_DOCKER_IMAGE fallback configured.
 */
export async function getTrackAudio(
  trackId: number,
  opts?: { sampleRate?: number | null },
): Promise<TrackAudio | null | typeof AUDIO_BUSY> {
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    include: { album: { select: { owned: true } } },
  });
  if (!track || !track.album?.owned) return null;

  const format = resolvePcmFormat(track.codec, track, opts?.sampleRate);
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

  // One ffmpeg per stream, none queued. A slot is held until the child
  // exits — on the LAN that's about a second per track (the decode runs
  // far faster than real time and the client drains it as fast as the
  // network allows); a slow client holds it for as long as its download
  // takes, since ffmpeg blocks on the pipe once Node stops reading.
  const release = audioSemaphore().tryAcquire();
  if (!release) return AUDIO_BUSY;

  const stream = await pcmStream(absPath, musicRoot, format, release);
  if (!stream) {
    release();
    return null;
  }
  return { stream, format, estimatedBytes: estimatePcmBytes(track.durationSecs, format) };
}
