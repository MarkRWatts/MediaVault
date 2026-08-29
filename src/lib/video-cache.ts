// On-demand video preparation: resolves a Version (or Scene) to playable
// bytes, running an ffmpeg pass (remux and/or audio/video transcode, per
// video-playback.ts) exactly once per file and caching the result under
// VIDEO_CACHE_DIR. A file that's already been prepared (or never needed to
// be) is served as a plain byte-range read, same as before.
//
// The first play of a file that *does* need preparing is different: rather
// than waiting for the whole thing to finish (fine for a 3-second test clip,
// a multi-minute wait for a real 40GB remux — nobody's pressing Play for
// that), GET /stream starts serving the ffmpeg output file *while ffmpeg is
// still writing it*, via the tailing reader in tailing-stream.ts. That only
// works because the output is fragmented MP4 (see video-playback.ts) — a
// valid prefix exists at every point during the write, not just at the end.
// The written file doubles as the cache for every subsequent play, so this
// is still "prepare once", just streamed live on the first pass instead of
// blocking on it.
//
// Same local-ffmpeg-vs-docker fallback as ffprobe.ts/audio-stream.ts.
//
// Scope: Film Versions and Adult Scenes — TV episodes (EpisodeFile) aren't
// wired up yet. Every process-local cache key below is namespaced by kind
// (`${kind}-${id}`), not a bare numeric id — Scene.id and Version.id are
// independent autoincrement sequences and *will* collide on the same number
// eventually; this was caught before it became a real bug, not after.

import { execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";
import { planVideoPlayback, buildFfmpegArgs, type VideoPlaybackPlan } from "@/lib/video-playback";

export type MediaKind = "film" | "scene";

export type VideoStatus =
  | { state: "not-found" }
  | { state: "direct" }
  | { state: "ready" }
  | { state: "preparing" }
  | { state: "idle" }
  | { state: "error"; message: string };

interface ResolvedMedia {
  id: number;
  filePath: string;
  videoCodec: string | null;
  container: string | null;
  audioTracks: { streamIdx: number; codec: string | null; profile: string | null; channels: number | null }[];
}

function cacheKey(kind: MediaKind, id: number): string {
  return `${kind}-${id}`;
}

function cacheDir(): string {
  return path.resolve(process.env.VIDEO_CACHE_DIR || "./data/video-cache");
}

function cachePath(kind: MediaKind, id: number): string {
  return path.join(cacheDir(), `${cacheKey(kind, id)}.mp4`);
}

// Stable (not randomised) so a reader that shows up mid-prepare can find the
// same in-progress file a concurrent/earlier request is already writing to.
function partialPath(kind: MediaKind, id: number): string {
  return path.join(cacheDir(), `${cacheKey(kind, id)}.mp4.partial`);
}

const DEFAULT_MAX_CACHE_BYTES = 10 * 1024 ** 3; // 10 GiB -- this runs on a small, shared VM.

export function maxCacheBytes(): number {
  const raw = Number(process.env.VIDEO_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CACHE_BYTES;
}

export interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Pure decision: given the cache's current contents and a byte budget, which
 * files to delete (oldest-last-played first) to get back under budget. No
 * I/O here so this is cheap to test exhaustively -- see enforceCacheLimit
 * for the readdir/stat/rm side. */
export function selectEntriesToEvict(entries: CacheEntry[], limitBytes: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= limitBytes) return [];

  const oldestFirst = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toEvict: string[] = [];
  let remaining = total;
  for (const entry of oldestFirst) {
    if (remaining <= limitBytes) break;
    toEvict.push(entry.path);
    remaining -= entry.size;
  }
  return toEvict;
}

/** Runs after every successful prepare. mtime is used as the LRU clock
 * rather than atime, since atime updates aren't guaranteed by the
 * filesystem (many mounts use noatime/relatime) -- touchCacheFile below
 * keeps it current on every real play instead. */
async function enforceCacheLimit(): Promise<void> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }

  const entries: CacheEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".mp4")) continue; // never evict a live .partial write
    const p = path.join(dir, name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat) entries.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  for (const p of selectEntriesToEvict(entries, maxCacheBytes())) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
}

/** Marks a cached file as just-played, so it looks recently-used to the LRU
 * eviction above even on a filesystem that doesn't track real atime.
 * Best-effort -- a failure here should never break playback. */
function touchCacheFile(p: string): void {
  const now = new Date();
  fs.utimes(p, now, now).catch(() => {});
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-flight prepare jobs (keyed by cacheKey) and the last error for one that
// failed, so status polling (and the tailing reader) can see it. Both are
// process-local — fine for a single-instance deployment; a restart just
// means an in-progress job is silently abandoned. A stale .partial file left
// behind by a killed process is cleaned up the next time that key is
// prepared (see prepare()), not on startup.
const jobs = new Map<string, Promise<void>>();
const jobErrors = new Map<string, string>();

// How many live stream responses are currently reading a key's tailing
// output. Pausing doesn't touch this -- the client just stops asking the
// underlying connection for more bytes, it doesn't close it -- only an
// actual disconnect (closed tab, navigation, stop) does. A short grace
// period after the last reader leaves tolerates a quick reconnect/replay
// without needlessly throwing away in-progress work.
const activeReaders = new Map<string, number>();
const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CANCEL_GRACE_MS = 8000;

function cancelIfAbandoned(key: string): void {
  cancelTimers.delete(key);
  if (activeReaders.has(key)) return; // someone reconnected during the grace period
  const proc = activeProcesses.get(key);
  if (!proc) return;
  cancelledJobs.add(key);
  proc.kill("SIGTERM");
}

/** Call when a stream response starts tailing a key's in-progress output.
 * Returns a function to call when that response ends (naturally or via
 * disconnect) -- once the last reader for a key is gone, its ffmpeg job is
 * killed after a grace period rather than left running for no one. */
export function registerStreamReader(kind: MediaKind, id: number): () => void {
  const key = cacheKey(kind, id);
  activeReaders.set(key, (activeReaders.get(key) ?? 0) + 1);
  const pending = cancelTimers.get(key);
  if (pending) {
    clearTimeout(pending);
    cancelTimers.delete(key);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeReaders.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      activeReaders.delete(key);
      cancelTimers.set(key, setTimeout(() => cancelIfAbandoned(key), CANCEL_GRACE_MS));
    } else {
      activeReaders.set(key, remaining);
    }
  };
}

async function loadVersion(versionId: number): Promise<ResolvedMedia | null> {
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    include: { audioTracks: true, film: { select: { owned: true } } },
  });
  if (!version || !version.film?.owned) return null;
  return {
    id: version.id,
    filePath: version.filePath,
    videoCodec: version.videoCodec,
    container: version.container,
    audioTracks: version.audioTracks,
  };
}

/** Scene has no per-track table the way Version/AudioTrack does (out of
 * scope — see ADULT_PLAN.md) — probe the file fresh instead of reading
 * stored rows. Fine: this runs once per play (prepare/status check), not
 * per chunk, and ffprobe against a local/SMB file is fast. */
async function loadScene(sceneId: number): Promise<ResolvedMedia | null> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) return null;

  const adultPath = process.env.ADULT_PATH;
  if (!adultPath) return null;
  const absPath = resolveSourcePath("scene", scene.filePath);
  if (!absPath) return null;

  try {
    const result = await probe(absPath);
    return {
      id: scene.id,
      filePath: scene.filePath,
      videoCodec: result.videoCodec,
      container: scene.container,
      audioTracks: result.audioTracks,
    };
  } catch {
    return null;
  }
}

async function loadMedia(kind: MediaKind, id: number): Promise<ResolvedMedia | null> {
  return kind === "film" ? loadVersion(id) : loadScene(id);
}

function mediaRootEnv(kind: MediaKind): string {
  return kind === "film" ? "MOVIES_PATH" : "ADULT_PATH";
}

function resolveSourcePath(kind: MediaKind, filePath: string): string | null {
  const mediaRoot = process.env[mediaRootEnv(kind)];
  if (!mediaRoot) return null;
  const root = path.resolve(mediaRoot);
  const absPath = path.resolve(root, filePath);
  // Path-traversal guard, same shape as /api/audio and /api/cover.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return absPath;
}

let hasLocalFfmpegPromise: Promise<boolean> | null = null;
function detectLocalFfmpeg(): Promise<boolean> {
  if (!hasLocalFfmpegPromise) {
    hasLocalFfmpegPromise = new Promise<boolean>((resolve) => {
      execFile("ffmpeg", ["-version"], (err) => resolve(!err));
    });
  }
  return hasLocalFfmpegPromise;
}

// The running ffmpeg (or docker-run wrapping it) child process per key, so a
// cancelled play (see registerStreamReader) has something to kill.
const activeProcesses = new Map<string, ChildProcess>();
// Set just before killing a process for cancellation, so its exit looks like
// a deliberate stop rather than a real failure -- see runTrackedProcess.
const cancelledJobs = new Set<string>();

class PrepareCancelledError extends Error {}

function runTrackedProcess(key: string, cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16 }, (err) => {
      activeProcesses.delete(key);
      if (err) {
        if (cancelledJobs.delete(key)) {
          reject(new PrepareCancelledError("stopped -- no active viewers"));
        } else {
          reject(err);
        }
        return;
      }
      resolve();
    });
    activeProcesses.set(key, child);
  });
}

async function runFfmpeg(
  kind: MediaKind,
  sourceAbsPath: string,
  outAbsPath: string,
  plan: VideoPlaybackPlan,
  sourceChannels: number | null,
  key: string,
): Promise<void> {
  const hasLocal = await detectLocalFfmpeg();

  if (hasLocal) {
    const args = buildFfmpegArgs(sourceAbsPath, outAbsPath, plan, sourceChannels);
    await runTrackedProcess(key, "ffmpeg", args);
    return;
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) throw new Error("ffmpeg not found on PATH and FFPROBE_DOCKER_IMAGE is not set");

  const mediaRoot = process.env[mediaRootEnv(kind)];
  if (!mediaRoot) throw new Error(`${mediaRootEnv(kind)} not set`);
  const root = path.resolve(mediaRoot);
  const rel = path.relative(root, sourceAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`source path outside ${mediaRootEnv(kind)}`);
  const containerIn = `/media-root/${rel.split(path.sep).join("/")}`;

  const outDir = path.dirname(outAbsPath);
  const outName = path.basename(outAbsPath);
  const containerOut = `/out/${outName}`;

  const args = buildFfmpegArgs(containerIn, containerOut, plan, sourceChannels);
  await runTrackedProcess(key, "docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/ffmpeg",
    "-v",
    `${root}:/media-root:ro`,
    "-v",
    `${outDir}:/out`,
    dockerImage,
    ...args,
  ]);
}

async function prepare(kind: MediaKind, id: number, media: ResolvedMedia, plan: VideoPlaybackPlan): Promise<void> {
  const key = cacheKey(kind, id);
  const sourceAbsPath = resolveSourcePath(kind, media.filePath);
  if (!sourceAbsPath) throw new Error(`${mediaRootEnv(kind)} not set or file path outside its root`);
  await fs.access(sourceAbsPath); // throws if the file's missing on disk

  await fs.mkdir(cacheDir(), { recursive: true });
  const partial = partialPath(kind, id);
  // Stable filename means a leftover from a killed/interrupted previous run
  // could still be sitting here — start clean rather than have ffmpeg (or a
  // tailing reader that showed up first) see a mix of old and new content.
  await fs.rm(partial, { force: true }).catch(() => {});

  const sourceChannels =
    plan.audioStreamIndex !== null
      ? (media.audioTracks.find((t) => t.streamIdx === plan.audioStreamIndex)?.channels ?? null)
      : null;

  try {
    await runFfmpeg(kind, sourceAbsPath, partial, plan, sourceChannels, key);
    await fs.rename(partial, cachePath(kind, id));
    await enforceCacheLimit();
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {});
    // A deliberate stop (no one was still watching) isn't a failure -- don't
    // record it as a jobError, just leave things clean for the next play to
    // start fresh. See registerStreamReader.
    if (err instanceof PrepareCancelledError) return;
    throw err;
  }
}

/** Kick off preparation if it isn't already cached, in flight, or previously
 * failed for this exact request. Fire-and-forget — callers poll getVideoStatus
 * or (for actual playback) read via resolveVideoStream's tailing mode. */
export function requestVideoPrepare(kind: MediaKind, id: number, media: ResolvedMedia, plan: VideoPlaybackPlan): void {
  const key = cacheKey(kind, id);
  if (jobs.has(key)) return;
  jobErrors.delete(key);
  const job = prepare(kind, id, media, plan)
    .catch((err) => {
      jobErrors.set(key, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      jobs.delete(key);
    });
  jobs.set(key, job);
}

async function loadAndPlan(kind: MediaKind, id: number): Promise<{ media: ResolvedMedia; plan: VideoPlaybackPlan } | null> {
  const media = await loadMedia(kind, id);
  if (!media) return null;
  const plan = planVideoPlayback(media); // null if not probed yet
  if (!plan) return null;
  return { media, plan };
}

export async function getVideoStatus(kind: MediaKind, id: number): Promise<VideoStatus> {
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { state: "not-found" };
  const { media, plan } = loaded;
  const key = cacheKey(kind, id);

  if (plan.tier === "direct") {
    const sourceAbsPath = resolveSourcePath(kind, media.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { state: "not-found" };
    return { state: "direct" };
  }

  if (await fileExists(cachePath(kind, id))) return { state: "ready" };
  if (jobs.has(key) || (await fileExists(partialPath(kind, id)))) return { state: "preparing" };
  const error = jobErrors.get(key);
  if (error) return { state: "error", message: error };
  return { state: "idle" };
}

/** POST /prepare hits this: starts the job (if needed) and returns the
 * status the client should now poll on. Optional pre-warming (e.g. from the
 * film detail page, before Play is even pressed) — GET /stream no longer
 * needs this called first, see resolveVideoStream. */
export async function triggerVideoPrepare(kind: MediaKind, id: number): Promise<VideoStatus> {
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { state: "not-found" };
  const { media, plan } = loaded;

  if (plan.tier === "direct") return getVideoStatus(kind, id);
  if (await fileExists(cachePath(kind, id))) return { state: "ready" };

  requestVideoPrepare(kind, id, media, plan);
  return { state: "preparing" };
}

export type VideoStreamResolution =
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "not-started" }
  | { kind: "complete"; absPath: string; contentType: string }
  | {
      kind: "tailing";
      absPath: string;
      contentType: string;
      /** True once the file at absPath has stopped growing for good. */
      isDone: () => Promise<boolean>;
      /** Non-null once the write has failed. */
      hasErrored: () => string | null;
    };

const START_POLL_INTERVAL_MS = 200;
const START_POLL_MAX_ATTEMPTS = 50; // ~10s to see ffmpeg create its output file

/**
 * What GET /stream should actually serve. Self-starting: if nothing has
 * been prepared or requested yet, this kicks off the job itself (same as
 * triggerVideoPrepare) and waits briefly for ffmpeg to create its output
 * file, then hands back a tailing resolution so the caller can start
 * streaming immediately rather than waiting for the whole file.
 */
export async function resolveVideoStream(kind: MediaKind, id: number): Promise<VideoStreamResolution> {
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { kind: "not-found" };
  const { media, plan } = loaded;
  const key = cacheKey(kind, id);

  if (plan.tier === "direct") {
    const sourceAbsPath = resolveSourcePath(kind, media.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { kind: "not-found" };
    return { kind: "complete", absPath: sourceAbsPath, contentType: "video/mp4" };
  }

  const finalPath = cachePath(kind, id);
  if (await fileExists(finalPath)) {
    touchCacheFile(finalPath);
    return { kind: "complete", absPath: finalPath, contentType: "video/mp4" };
  }

  const partial = partialPath(kind, id);
  const tailingResolution = (): VideoStreamResolution => ({
    kind: "tailing",
    absPath: partial,
    contentType: "video/mp4",
    isDone: () => fileExists(finalPath),
    hasErrored: () => jobErrors.get(key) ?? null,
  });

  if (await fileExists(partial)) return tailingResolution();

  // Nothing started yet — kick it off and give ffmpeg a moment to actually
  // create its output file (near-instant in practice; the poll is just a
  // safety margin for a slow-to-open source over a network share).
  requestVideoPrepare(kind, id, media, plan);
  for (let attempt = 0; attempt < START_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(START_POLL_INTERVAL_MS);
    if (await fileExists(finalPath)) {
      touchCacheFile(finalPath);
      return { kind: "complete", absPath: finalPath, contentType: "video/mp4" };
    }
    if (await fileExists(partial)) return tailingResolution();
    const error = jobErrors.get(key);
    if (error) return { kind: "error", message: error };
  }
  return { kind: "not-started" };
}
