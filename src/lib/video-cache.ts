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
import { promises as fs, rmSync } from "node:fs";
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

// Headroom the disk must keep AFTER a prepare would finish. A prepare that
// would leave less than this is refused with a clear error rather than
// filling the volume that also holds the SQLite database.
const MIN_FREE_DISK_BYTES = 1 * 1024 ** 3;

export interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** A live `.partial` write (or the incoming file being budgeted for):
   *  counts toward the total, is never a candidate for eviction. */
  pinned?: boolean;
}

/** Pure decision: given the cache's current contents and a byte budget, which
 * files to delete (oldest-last-played first) to get back under budget. No
 * I/O here so this is cheap to test exhaustively -- see enforceCacheLimit /
 * makeRoomFor for the readdir/stat/rm side. Pinned entries (in-progress
 * writes, the file that was just produced, the one about to be) count
 * toward the total but are never evicted, so the result can fall short of
 * the budget when a single pinned file is bigger than it -- that's allowed
 * (see prepare): the cap bounds what's *retained*, not what can be
 * produced. */
export function selectEntriesToEvict(entries: CacheEntry[], limitBytes: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= limitBytes) return [];

  const candidates = entries.filter((e) => !e.pinned).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toEvict: string[] = [];
  let remaining = total;
  for (const entry of candidates) {
    if (remaining <= limitBytes) break;
    toEvict.push(entry.path);
    remaining -= entry.size;
  }
  return toEvict;
}

/** Cache directory listing with `.partial` files included and pinned --
 * an in-flight remux of a Blu-ray can be tens of GB, and the previous
 * version of this accounting ignored partials entirely, which is exactly
 * how the disk filled. */
async function readCacheEntries(): Promise<CacheEntry[]> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: CacheEntry[] = [];
  for (const name of names) {
    const isFinal = name.endsWith(".mp4");
    const isPartial = name.endsWith(".mp4.partial");
    if (!isFinal && !isPartial) continue;
    const p = path.join(dir, name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat) entries.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs, pinned: isPartial });
  }
  return entries;
}

/** mtime is used as the LRU clock rather than atime, since atime updates
 * aren't guaranteed by the filesystem (many mounts use noatime/relatime) --
 * touchCacheFile below keeps it current on every real play instead.
 * `protect` is the file that was just produced: it is never evicted by the
 * pass that follows its own creation, even if it alone exceeds the cap
 * (otherwise a big remux would be deleted the moment it finished and
 * re-prepared on every play). It becomes an ordinary LRU candidate the
 * next time something else needs the room. */
async function enforceCacheLimit(protect?: string): Promise<void> {
  const entries = (await readCacheEntries()).map((e) => (e.path === protect ? { ...e, pinned: true } : e));
  for (const p of selectEntriesToEvict(entries, maxCacheBytes())) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
}

/** Before a prepare starts: evict least-recently-played files until the
 * incoming output (estimated at `bytes`) fits the cap, then refuse outright
 * if the *disk* still can't hold it with headroom to spare. The cap is a
 * retention policy; the free-space check is the actual safety net. */
async function makeRoomFor(bytes: number): Promise<void> {
  const dir = cacheDir();
  const entries = await readCacheEntries();
  const incoming: CacheEntry = { path: "<incoming>", size: bytes, mtimeMs: Number.POSITIVE_INFINITY, pinned: true };
  for (const p of selectEntriesToEvict([...entries, incoming], maxCacheBytes())) {
    await fs.rm(p, { force: true }).catch(() => {});
  }

  const free = await freeDiskBytes(dir);
  if (free !== null && free - bytes < MIN_FREE_DISK_BYTES) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new Error(
      `Not enough disk space to prepare this file: it needs about ${gb(bytes)} GB and the cache volume has ${gb(free)} GB free.`,
    );
  }
}

async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Delete `.partial` files nobody in this process is writing. Every writer
 * is an in-process ffmpeg job, so on a fresh process *every* partial is an
 * orphan -- left behind by a deploy or crash that killed ffmpeg mid-write
 * (a Blu-ray remux partial is the size of its source, so one of these can
 * be most of a small VM's disk). Exported with the directory and liveness
 * check injected so it can be tested against a temp dir. */
export async function sweepOrphanedPartialsIn(dir: string, isLive: (key: string) => boolean): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".mp4.partial")) continue;
    const key = name.slice(0, -".mp4.partial".length);
    if (isLive(key)) continue;
    const p = path.join(dir, name);
    await fs.rm(p, { force: true }).catch(() => {});
    removed.push(p);
  }
  return removed;
}

let startupSweep: Promise<void> | null = null;
/** Runs once per process, lazily on the first playback-related call (there
 * is no server-start hook this module can rely on in both dev and prod).
 * Idempotent and cheap after the first call. */
function ensureStartupSweep(): Promise<void> {
  if (!startupSweep) {
    startupSweep = sweepOrphanedPartialsIn(cacheDir(), (key) => jobs.has(key))
      .then(() => undefined)
      .catch(() => undefined);
  }
  return startupSweep;
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
// process-local — fine for a single-instance deployment. Because every
// writer is in-process, "a .partial exists but `jobs` has no entry for it"
// is a reliable orphan signal: the process that was writing it is gone.
// That's swept on the first playback call after startup
// (ensureStartupSweep) and again per-key whenever status/stream sees it,
// and the shutdown hook below tries not to leave any behind in the first
// place.
const jobs = new Map<string, Promise<void>>();
const jobErrors = new Map<string, string>();
// The .partial each live job is writing, so a shutdown can unlink them
// synchronously without re-deriving paths.
const activePartials = new Map<string, string>();

// How many live stream responses are currently reading a key's tailing
// output. Pausing doesn't touch this -- the client just stops asking the
// underlying connection for more bytes, it doesn't close it -- only an
// actual disconnect (closed tab, navigation, stop) does. A grace period
// after the last reader leaves tolerates a reconnect without throwing away
// in-progress work: this used to be 8s, which meant a Wi-Fi hiccup over a
// VPN killed the ffmpeg job and the reconnect started the whole remux
// again from byte 0. Two minutes covers a real network blip; a viewer who
// genuinely left still stops the job well before it finishes a long film.
const activeReaders = new Map<string, number>();
const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CANCEL_GRACE_MS = 120_000;

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

// On SIGTERM/SIGINT (a `docker stop`, a deploy, Ctrl-C in dev): stop every
// running ffmpeg and unlink the partial it was writing, synchronously --
// there is no time for the async cleanup in prepare() to run before the
// process exits. ffmpeg on SIGTERM finishes its current write and exits;
// the unlink means whatever it still flushes goes to an already-deleted
// inode. Prepended so it runs before Next's own handler, which may call
// process.exit in the same tick. The startup sweep is the backstop for a
// SIGKILL, which no handler can catch.
let shutdownHookInstalled = false;
function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  const stopAll = () => {
    for (const [key, proc] of activeProcesses) {
      cancelledJobs.add(key);
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
    for (const partial of activePartials.values()) {
      try {
        rmSync(partial, { force: true });
      } catch {
        // Best effort; the startup sweep catches anything left.
      }
    }
  };
  process.prependListener("SIGTERM", stopAll);
  process.prependListener("SIGINT", stopAll);
}

function runTrackedProcess(key: string, cmd: string, args: string[]): Promise<void> {
  installShutdownHook();
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16 }, (err, _stdout, stderr) => {
      activeProcesses.delete(key);
      if (err) {
        if (cancelledJobs.delete(key)) {
          reject(new PrepareCancelledError("stopped -- no active viewers"));
        } else {
          // execFile's own message is "Command failed: <entire argv>" plus
          // everything ffmpeg printed. With -loglevel error (see
          // buildFfmpegArgs) stderr is just the actual problem, so surface
          // that -- it's what ends up in the player's error message.
          const detail = String(stderr ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" ");
          reject(new Error(detail ? `ffmpeg failed: ${detail}` : err.message));
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

  // Output size is bounded by the source for every plan this app produces
  // (stream copies are byte-for-byte; the only encodes are DVD-era MPEG-2/
  // VC-1 to x264 and lossless audio to AAC, both smaller). Make room under
  // the cap for it and refuse if the disk itself can't take it.
  const sourceSize = (await fs.stat(sourceAbsPath)).size;
  await makeRoomFor(sourceSize);

  const sourceChannels =
    plan.audioStreamIndex !== null
      ? (media.audioTracks.find((t) => t.streamIdx === plan.audioStreamIndex)?.channels ?? null)
      : null;

  activePartials.set(key, partial);
  try {
    await runFfmpeg(kind, sourceAbsPath, partial, plan, sourceChannels, key);
    const finalPath = cachePath(kind, id);
    await fs.rename(partial, finalPath);
    await enforceCacheLimit(finalPath);
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {});
    // A deliberate stop (no one was still watching) isn't a failure -- don't
    // record it as a jobError, just leave things clean for the next play to
    // start fresh. See registerStreamReader.
    if (err instanceof PrepareCancelledError) return;
    throw err;
  } finally {
    activePartials.delete(key);
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

/** A `.partial` with no job writing it is an orphan (see the `jobs` comment).
 * Removing it here -- rather than reporting "preparing" for a file nobody
 * is producing -- is what used to leave a film stuck on "Buffering…" forever
 * after any restart mid-prepare. */
async function discardOrphanedPartial(kind: MediaKind, id: number): Promise<void> {
  if (jobs.has(cacheKey(kind, id))) return;
  await fs.rm(partialPath(kind, id), { force: true }).catch(() => {});
}

export async function getVideoStatus(kind: MediaKind, id: number): Promise<VideoStatus> {
  await ensureStartupSweep();
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
  if (jobs.has(key)) return { state: "preparing" };
  await discardOrphanedPartial(kind, id);
  const error = jobErrors.get(key);
  if (error) return { state: "error", message: error };
  return { state: "idle" };
}

/** POST /prepare hits this: starts the job (if needed) and returns the
 * status the client should now poll on. Optional pre-warming (e.g. from the
 * film detail page, before Play is even pressed) — GET /stream no longer
 * needs this called first, see resolveVideoStream. */
export async function triggerVideoPrepare(kind: MediaKind, id: number): Promise<VideoStatus> {
  await ensureStartupSweep();
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
  await ensureStartupSweep();
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
    // A real ffmpeg failure, or the job simply no longer existing while the
    // file is still incomplete (cancelled, or the process restarted): either
    // way the reader must stop rather than wait forever for bytes that
    // aren't coming. The tailing reader checks isDone before this, so a job
    // that finished normally never trips it.
    hasErrored: () =>
      jobErrors.get(key) ?? (jobs.has(key) ? null : "preparation stopped before the file was complete"),
  });

  if (jobs.has(key) && (await fileExists(partial))) return tailingResolution();
  await discardOrphanedPartial(kind, id);

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
