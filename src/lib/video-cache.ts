// On-demand video preparation: resolves a Version to playable bytes, running
// an ffmpeg pass (remux and/or audio/video transcode, per video-playback.ts)
// exactly once per file and caching the result under VIDEO_CACHE_DIR. A file
// that's already been prepared (or never needed to be) is served as a plain
// byte-range read, same as before.
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
// Scope: Film Versions only for this first pass — TV episodes (EpisodeFile)
// aren't wired up yet.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { planVideoPlayback, buildFfmpegArgs, type VideoPlaybackPlan } from "@/lib/video-playback";

const execFileAsync = promisify(execFile);

export type VideoStatus =
  | { state: "not-found" }
  | { state: "direct" }
  | { state: "ready" }
  | { state: "preparing" }
  | { state: "idle" }
  | { state: "error"; message: string };

interface ResolvedVersion {
  id: number;
  filePath: string;
  videoCodec: string | null;
  container: string | null;
  audioTracks: { streamIdx: number; codec: string | null; profile: string | null; channels: number | null }[];
}

function cacheDir(): string {
  return path.resolve(process.env.VIDEO_CACHE_DIR || "./data/video-cache");
}

function cachePath(versionId: number): string {
  return path.join(cacheDir(), `${versionId}.mp4`);
}

// Stable (not randomised) so a reader that shows up mid-prepare can find the
// same in-progress file a concurrent/earlier request is already writing to.
function partialPath(versionId: number): string {
  return path.join(cacheDir(), `${versionId}.mp4.partial`);
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

// In-flight prepare jobs (keyed by version id) and the last error for a
// version that failed, so status polling (and the tailing reader) can see
// it. Both are process-local — fine for a single-instance deployment; a
// restart just means an in-progress job is silently abandoned. A stale
// .partial file left behind by a killed process is cleaned up the next time
// that version is prepared (see prepare()), not on startup.
const jobs = new Map<number, Promise<void>>();
const jobErrors = new Map<number, string>();

async function loadVersion(versionId: number): Promise<ResolvedVersion | null> {
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

function resolveSourcePath(filePath: string): string | null {
  const moviesPath = process.env.MOVIES_PATH;
  if (!moviesPath) return null;
  const root = path.resolve(moviesPath);
  const absPath = path.resolve(root, filePath);
  // Path-traversal guard, same shape as /api/audio and /api/cover.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return absPath;
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

async function runFfmpeg(sourceAbsPath: string, outAbsPath: string, plan: VideoPlaybackPlan, sourceChannels: number | null): Promise<void> {
  const hasLocal = await detectLocalFfmpeg();

  if (hasLocal) {
    const args = buildFfmpegArgs(sourceAbsPath, outAbsPath, plan, sourceChannels);
    await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16 });
    return;
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) throw new Error("ffmpeg not found on PATH and FFPROBE_DOCKER_IMAGE is not set");

  const moviesPath = process.env.MOVIES_PATH;
  if (!moviesPath) throw new Error("MOVIES_PATH not set");
  const root = path.resolve(moviesPath);
  const rel = path.relative(root, sourceAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("source path outside MOVIES_PATH");
  const containerIn = `/movies-root/${rel.split(path.sep).join("/")}`;

  const outDir = path.dirname(outAbsPath);
  const outName = path.basename(outAbsPath);
  const containerOut = `/out/${outName}`;

  const args = buildFfmpegArgs(containerIn, containerOut, plan, sourceChannels);
  await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/ffmpeg",
      "-v",
      `${root}:/movies-root:ro`,
      "-v",
      `${outDir}:/out`,
      dockerImage,
      ...args,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );
}

async function prepare(versionId: number, version: ResolvedVersion, plan: VideoPlaybackPlan): Promise<void> {
  const sourceAbsPath = resolveSourcePath(version.filePath);
  if (!sourceAbsPath) throw new Error("MOVIES_PATH not set or file path outside movie root");
  await fs.access(sourceAbsPath); // throws if the file's missing on disk

  await fs.mkdir(cacheDir(), { recursive: true });
  const partial = partialPath(versionId);
  // Stable filename means a leftover from a killed/interrupted previous run
  // could still be sitting here — start clean rather than have ffmpeg (or a
  // tailing reader that showed up first) see a mix of old and new content.
  await fs.rm(partial, { force: true }).catch(() => {});

  const sourceChannels =
    plan.audioStreamIndex !== null
      ? (version.audioTracks.find((t) => t.streamIdx === plan.audioStreamIndex)?.channels ?? null)
      : null;

  try {
    await runFfmpeg(sourceAbsPath, partial, plan, sourceChannels);
    await fs.rename(partial, cachePath(versionId));
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
}

/** Kick off preparation if it isn't already cached, in flight, or previously
 * failed for this exact request. Fire-and-forget — callers poll getVideoStatus
 * or (for actual playback) read via resolveVideoStream's tailing mode. */
export function requestVideoPrepare(versionId: number, version: ResolvedVersion, plan: VideoPlaybackPlan): void {
  if (jobs.has(versionId)) return;
  jobErrors.delete(versionId);
  const job = prepare(versionId, version, plan)
    .catch((err) => {
      jobErrors.set(versionId, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      jobs.delete(versionId);
    });
  jobs.set(versionId, job);
}

async function loadAndPlan(versionId: number): Promise<{ version: ResolvedVersion; plan: VideoPlaybackPlan } | null> {
  const version = await loadVersion(versionId);
  if (!version) return null;
  const plan = planVideoPlayback(version); // null if not probed yet
  if (!plan) return null;
  return { version, plan };
}

export async function getVideoStatus(versionId: number): Promise<VideoStatus> {
  const loaded = await loadAndPlan(versionId);
  if (!loaded) return { state: "not-found" };
  const { version, plan } = loaded;

  if (plan.tier === "direct") {
    const sourceAbsPath = resolveSourcePath(version.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { state: "not-found" };
    return { state: "direct" };
  }

  if (await fileExists(cachePath(versionId))) return { state: "ready" };
  if (jobs.has(versionId) || (await fileExists(partialPath(versionId)))) return { state: "preparing" };
  const error = jobErrors.get(versionId);
  if (error) return { state: "error", message: error };
  return { state: "idle" };
}

/** POST /prepare hits this: starts the job (if needed) and returns the
 * status the client should now poll on. Optional pre-warming (e.g. from the
 * film detail page, before Play is even pressed) — GET /stream no longer
 * needs this called first, see resolveVideoStream. */
export async function triggerVideoPrepare(versionId: number): Promise<VideoStatus> {
  const loaded = await loadAndPlan(versionId);
  if (!loaded) return { state: "not-found" };
  const { version, plan } = loaded;

  if (plan.tier === "direct") return getVideoStatus(versionId);
  if (await fileExists(cachePath(versionId))) return { state: "ready" };

  requestVideoPrepare(versionId, version, plan);
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
export async function resolveVideoStream(versionId: number): Promise<VideoStreamResolution> {
  const loaded = await loadAndPlan(versionId);
  if (!loaded) return { kind: "not-found" };
  const { version, plan } = loaded;

  if (plan.tier === "direct") {
    const sourceAbsPath = resolveSourcePath(version.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { kind: "not-found" };
    return { kind: "complete", absPath: sourceAbsPath, contentType: "video/mp4" };
  }

  const finalPath = cachePath(versionId);
  if (await fileExists(finalPath)) {
    return { kind: "complete", absPath: finalPath, contentType: "video/mp4" };
  }

  const partial = partialPath(versionId);
  const tailingResolution = (): VideoStreamResolution => ({
    kind: "tailing",
    absPath: partial,
    contentType: "video/mp4",
    isDone: () => fileExists(finalPath),
    hasErrored: () => jobErrors.get(versionId) ?? null,
  });

  if (await fileExists(partial)) return tailingResolution();

  // Nothing started yet — kick it off and give ffmpeg a moment to actually
  // create its output file (near-instant in practice; the poll is just a
  // safety margin for a slow-to-open source over a network share).
  requestVideoPrepare(versionId, version, plan);
  for (let attempt = 0; attempt < START_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(START_POLL_INTERVAL_MS);
    if (await fileExists(finalPath)) return { kind: "complete", absPath: finalPath, contentType: "video/mp4" };
    if (await fileExists(partial)) return tailingResolution();
    const error = jobErrors.get(versionId);
    if (error) return { kind: "error", message: error };
  }
  return { kind: "not-started" };
}
