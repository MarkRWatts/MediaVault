// On-demand video preparation: resolves a Version to playable bytes, running
// an ffmpeg pass (remux and/or audio/video transcode, per video-playback.ts)
// exactly once per file and caching the result under VIDEO_CACHE_DIR. Every
// subsequent request — including seeks — is served as a plain byte-range
// file read, no ffmpeg involved. This is the same "prepare once, then direct
// play" shape the research doc's batch pre-processing idea (§6a) describes,
// just computed lazily on first access instead of eagerly for the library.
//
// Same local-ffmpeg-vs-docker fallback as ffprobe.ts/audio-stream.ts. Unlike
// audio-stream.ts, this runs ffmpeg to completion into a file rather than
// streaming stdout — HLS-style live segmenting was considered (see the
// research doc, §6) but a complete-then-serve MP4 sidesteps "ffmpeg's stdout
// isn't seekable" entirely, since the finished file gets normal Range
// support for free.
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

function tmpPath(versionId: number): string {
  return path.join(cacheDir(), `.tmp-${versionId}-${Math.random().toString(36).slice(2)}.mp4`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// In-flight prepare jobs (keyed by version id) and the last error for a
// version that failed, so status polling can report it. Both are process-
// local — fine for a single-instance deployment; a restart just means an
// in-progress job is silently abandoned and retried on the next request.
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
  const tmp = tmpPath(versionId);
  const sourceChannels =
    plan.audioStreamIndex !== null
      ? (version.audioTracks.find((t) => t.streamIdx === plan.audioStreamIndex)?.channels ?? null)
      : null;

  try {
    await runFfmpeg(sourceAbsPath, tmp, plan, sourceChannels);
    await fs.rename(tmp, cachePath(versionId));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Kick off preparation if it isn't already cached, in flight, or previously
 * failed for this exact request. Fire-and-forget — callers poll getVideoStatus. */
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
  if (jobs.has(versionId)) return { state: "preparing" };
  const error = jobErrors.get(versionId);
  if (error) return { state: "error", message: error };
  return { state: "idle" };
}

/** POST /prepare hits this: starts the job (if needed) and returns the
 * status the client should now poll on. */
export async function triggerVideoPrepare(versionId: number): Promise<VideoStatus> {
  const loaded = await loadAndPlan(versionId);
  if (!loaded) return { state: "not-found" };
  const { version, plan } = loaded;

  if (plan.tier === "direct") return getVideoStatus(versionId);
  if (await fileExists(cachePath(versionId))) return { state: "ready" };

  requestVideoPrepare(versionId, version, plan);
  return { state: "preparing" };
}

export interface ResolvedVideoFile {
  absPath: string;
  contentType: string;
}

/** What GET /stream should actually serve — the original file for "direct",
 * the cached derivative once "ready". Returns null otherwise (caller 404s). */
export async function resolveVideoFile(versionId: number): Promise<ResolvedVideoFile | null> {
  const loaded = await loadAndPlan(versionId);
  if (!loaded) return null;
  const { version, plan } = loaded;

  if (plan.tier === "direct") {
    const sourceAbsPath = resolveSourcePath(version.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return null;
    return { absPath: sourceAbsPath, contentType: "video/mp4" };
  }

  const cached = cachePath(versionId);
  if (!(await fileExists(cached))) return null;
  return { absPath: cached, contentType: "video/mp4" };
}
