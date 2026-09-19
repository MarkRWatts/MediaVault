// A smaller copy of a lossless track, for a native client on mobile data
// (GET /api/audio/:trackId/file?quality=aac). ALAC and FLAC run 25-35 MB a
// track; at 256 kbps AAC the same track is about 8 MB, which matters twice
// over on a train: less data, and a file that finishes inside a short burst
// of signal.
//
// AVFoundation needs a real, byte-range-seekable file, not a live ffmpeg
// pipe, so a track is converted ONCE into AUDIO_CACHE_DIR and served from
// there with serveFile like any other file. Converting takes 2-3 s on the
// VM (measured: a 3m46s ALAC, 32 MB -> 7.5 MB, 2.5 s with the fast coder,
// 5.6 s without), which is nothing to a client fetching tracks ahead of
// time and far too long to sit between pressing Play and hearing music. So
// a caller says which it is: a prefetch (`wait`) blocks for the conversion;
// a client about to play probes first (`wait: false` — answers at once and
// starts the conversion in the background) and streams the original if the
// copy isn't there yet. See the route for why that is a probe. Tracks that are already lossy (AAC, MP3) are never re-encoded —
// that would cost quality to save nothing — and go out as the original.
//
// The cache is bounded (AUDIO_CACHE_MAX_BYTES, least recently served first
// out) and self-healing: the source's mtime is in the file name, so a
// re-ripped track simply misses and the stale copy ages out.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectLocalFfmpeg, resolveTrackPath, trackFileContentType } from "@/lib/audio-stream";
import { audioSemaphore } from "@/lib/semaphore";
import { ffmpegPath } from "@/lib/ffmpeg-bin";

export type AudioQuality = "original" | "aac";

export function parseAudioQuality(raw: string | null): AudioQuality | null {
  if (raw === null || raw === "" || raw === "original") return "original";
  return raw === "aac" ? "aac" : null;
}

/** Only lossless sources are worth converting. */
export function needsTranscode(codec: string | null | undefined): boolean {
  const c = (codec ?? "").toLowerCase();
  return c === "alac" || c === "flac";
}

const AAC_BITRATE = "256k";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export function audioCacheDir(): string {
  return path.resolve(process.env.AUDIO_CACHE_DIR || "./data/audio-cache");
}

function audioCacheMaxBytes(): number {
  const n = Number(process.env.AUDIO_CACHE_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** `<trackId>-<source mtime>-aac256.m4a` — see the header on why mtime. */
export function transcodeFileName(trackId: number, sourceMtimeMs: number): string {
  return `${trackId}-${Math.floor(sourceMtimeMs)}-aac${AAC_BITRATE.replace("k", "")}.m4a`;
}

/** Which cached files to delete to get back under the limit: least
 *  recently served first, never `keep` (the one just written). Pure, for
 *  testing. */
export function transcodeEvictions(
  files: { name: string; bytes: number; lastServedMs: number }[],
  maxBytes: number,
  keep: string,
): string[] {
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => a.lastServedMs - b.lastServedMs)) {
    if (total <= maxBytes) break;
    if (f.name === keep) continue;
    out.push(f.name);
    total -= f.bytes;
  }
  return out;
}

export const TRANSCODE_BUSY = Symbol("transcode-busy");

// Two phones asking for the same cold track share one ffmpeg.
const inFlight = new Map<string, Promise<string | null>>();

/**
 * The file to serve for `trackId` at `quality`: the original for a lossy
 * source or quality "original", else the cached AAC copy, made now if it
 * doesn't exist. Null = not found / unplayable / ffmpeg unavailable;
 * TRANSCODE_BUSY = every ffmpeg slot is taken (the route answers 503).
 */
export async function resolveTrackFileForQuality(
  trackId: number,
  quality: AudioQuality,
  opts: { wait: boolean } = { wait: true },
): Promise<{ absPath: string; contentType: string; transcoded: boolean; needsTranscode: boolean } | null | typeof TRANSCODE_BUSY> {
  const resolved = await resolveTrackPath(trackId);
  if (!resolved) return null;
  const { track, absPath, musicRoot } = resolved;

  if (quality === "original" || !needsTranscode(track.codec)) {
    const contentType = trackFileContentType(track.codec);
    return contentType ? { absPath, contentType, transcoded: false, needsTranscode: false } : null;
  }

  const stat = await fs.stat(absPath);
  const name = transcodeFileName(trackId, stat.mtimeMs);
  const dir = audioCacheDir();
  const target = path.join(dir, name);

  try {
    await fs.access(target);
    // Served = used: this is the clock eviction goes by.
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => {});
    return { absPath: target, contentType: "audio/mp4", transcoded: true, needsTranscode: true };
  } catch {
    // Not cached yet.
  }

  let job = inFlight.get(name);
  if (!job) {
    const release = audioSemaphore().tryAcquire();
    if (!release) {
      if (opts.wait) return TRANSCODE_BUSY;
      const contentType = trackFileContentType(track.codec);
      return contentType ? { absPath, contentType, transcoded: false, needsTranscode: true } : null;
    }
    job = transcode(absPath, musicRoot, dir, name)
      .finally(() => {
        release();
        inFlight.delete(name);
      });
    inFlight.set(name, job);
  }
  if (!opts.wait) {
    // Someone is waiting to hear this: the original now, the copy next time.
    job.catch(() => {});
    const contentType = trackFileContentType(track.codec);
    return contentType ? { absPath, contentType, transcoded: false, needsTranscode: true } : null;
  }
  const made = await job;
  return made ? { absPath: made, contentType: "audio/mp4", transcoded: true, needsTranscode: true } : null;
}

async function transcode(absPath: string, musicRoot: string, dir: string, name: string): Promise<string | null> {
  await fs.mkdir(dir, { recursive: true });
  const partial = `${name}.${process.pid}.part`;
  // -movflags +faststart puts the index at the front, so a player can start
  // (and seek) on the first bytes of a range request.
  // The fast coder halves the time and is transparent at this bitrate.
  const encode = ["-map", "0:a:0", "-vn", "-c:a", "aac", "-aac_coder", "fast", "-b:a", AAC_BITRATE, "-movflags", "+faststart", "-f", "mp4"];
  const input = ["-nostdin", "-v", "error", "-y", "-i"];

  let cmd: string;
  let args: string[];
  if (await detectLocalFfmpeg()) {
    cmd = ffmpegPath();
    args = [...input, absPath, ...encode, path.join(dir, partial)];
  } else {
    // Local-dev shim, as in audio-stream.ts: ffmpeg from the probe image,
    // with the cache directory mounted for its output.
    const image = process.env.FFPROBE_DOCKER_IMAGE;
    if (!image) return null;
    const rel = path.relative(musicRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    cmd = "docker";
    args = [
      "run", "--rm", "--entrypoint", "/ffmpeg",
      "-v", `${musicRoot}:/probe-root:ro`, "-v", `${dir}:/out`,
      image, ...input, `/probe-root/${rel.split(path.sep).join("/")}`, ...encode, `/out/${partial}`,
    ];
  }

  const started = Date.now();
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  const partialPath = path.join(dir, partial);
  if (!ok) {
    await fs.rm(partialPath, { force: true });
    console.error(`[audio-transcode] ffmpeg failed for ${name}`);
    return null;
  }
  const target = path.join(dir, name);
  await fs.rename(partialPath, target);
  console.log(`[audio-transcode] ${name} in ${Date.now() - started} ms`);
  await trimCache(dir, name).catch(() => {});
  return target;
}

async function trimCache(dir: string, keep: string): Promise<void> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".m4a"));
  const files = await Promise.all(
    names.map(async (n) => {
      const st = await fs.stat(path.join(dir, n));
      return { name: n, bytes: st.size, lastServedMs: st.mtimeMs };
    }),
  );
  for (const n of transcodeEvictions(files, audioCacheMaxBytes(), keep)) {
    await fs.rm(path.join(dir, n), { force: true });
  }
}
