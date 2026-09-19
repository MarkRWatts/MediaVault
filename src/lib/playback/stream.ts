// One stream key's directory on disk: the segment table it was cut against,
// the plan.json that proves the two still belong together, and the small
// bookkeeping files the engine's housekeeping reads.
//
// Layout under VIDEO_CACHE_DIR (V4_PLAN.md, "Stream key"):
//
//   <key>/seg_NNNNN.ts     completed segments, renamed in from a head's
//                          staging directory -- never written in place
//   <key>/plan.json        exactly StreamPlanFile (decisions.ts)
//   <key>/.atime           LRU marker, mtime = last play
//   <key>/.complete        every segment in the table exists
//   <key>/.part-<headId>/  one live head's staging directory (head.ts)
//
// Why `.atime` rather than the directory's own mtime, which is what
// video-cache.ts uses for its entries: every promoted segment renames a file
// *into* this directory, and a rename bumps the directory's mtime. The LRU
// clock would then track "when did a head last write here", not "when did
// someone last watch this", and a stream nobody has played for a week would
// look freshly used for as long as its head ran. An explicit marker file,
// touched only by a playlist or segment *request*, says what was actually
// meant.

import { promises as fs } from "node:fs";
import path from "node:path";
import { cacheDir, dirSize } from "@/lib/video-cache";
import { HLS_SEGMENT_SECS, type Variant } from "@/lib/video-playback";
import { loadKeyframeIndex, saveKeyframeIndex } from "./keyframe-store";
import { getCuesKeyframes, getKeyframes, fixedSegmentTable, segmentTableFromKeyframes } from "./keyframes";
import {
  isPlanStale,
  segmentTableHash,
  PLAN_VERSION,
  type StreamCacheEntry,
  type StreamPlanFile,
  type StreamTier,
} from "./decisions";
import { buildStreamKey, parseSegmentFileName, segmentFileName, STREAM_KEY_RE } from "./stream-key";
import { PlaybackError, type ResolvedSource } from "./source";
import type { SegmentEntry } from "./types";

export const PLAN_FILE = "plan.json";
export const ATIME_FILE = ".atime";
export const COMPLETE_FILE = ".complete";
export const PART_DIR_PREFIX = ".part-";

export interface StreamContext {
  key: string;
  dir: string;
  variant: Variant;
  tier: StreamTier;
  segments: SegmentEntry[];
  /** Source keyframe times, for restarting a copy-tier head at a boundary.
   *  Empty on the transcode tier, which needs none. */
  keyframes: number[];
  source: ResolvedSource;
  /** Segment indices known to exist in `dir`. Seeded from one readdir when
   *  the stream is opened and maintained by the engine as heads promote
   *  segments, so "is this on disk?" and "is the table finished?" are map
   *  lookups rather than a stat storm per request -- a two-hour film is
   *  1200 segments, and asking the filesystem 1200 times per promoted
   *  segment is quadratic work for an answer this process already knows. */
  present: Set<number>;
}

export function streamDir(key: string): string {
  return path.join(cacheDir(), key);
}

export function segmentPath(dir: string, index: number): string {
  return path.join(dir, segmentFileName(index));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Marks a stream as just-played for the LRU. Best-effort: losing a touch
 *  costs a stream some freshness, never a play. */
export function touchStream(dir: string): void {
  fs.writeFile(path.join(dir, ATIME_FILE), "").catch(() => {});
}

/** The LRU clock for a stream directory: the `.atime` marker's mtime, or 0
 *  when there is no marker (a directory left by an older deploy, or one
 *  whose touch never landed -- either way, the oldest possible entry and
 *  the first to be evicted). */
export async function streamAtimeMs(dir: string): Promise<number> {
  const stat = await fs.stat(path.join(dir, ATIME_FILE)).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

/** Every v4 stream directory under VIDEO_CACHE_DIR, sized and dated for the
 *  budget pass. Only directories whose name is a valid stream key are
 *  considered: the old pipeline's entries live in the same root and are
 *  accounted for -- and swept -- by video-cache.ts alone. */
export async function readStreamCacheEntries(): Promise<StreamCacheEntry[]> {
  const root = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const entries: StreamCacheEntry[] = [];
  for (const name of names) {
    if (!STREAM_KEY_RE.test(name)) continue;
    const dir = path.join(root, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    entries.push({ key: name, path: dir, size: await dirSize(dir), atimeMs: await streamAtimeMs(dir) });
  }
  return entries;
}

/** Leftover staging directories anywhere under VIDEO_CACHE_DIR. Every head
 *  is an in-process child, so on a fresh process each one is the debris of a
 *  deploy or crash that killed ffmpeg mid-segment -- never live output. */
export async function sweepStagingDirs(): Promise<string[]> {
  const root = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!STREAM_KEY_RE.test(name)) continue;
    const dir = path.join(root, name);
    const inner = await fs.readdir(dir).catch(() => [] as string[]);
    for (const child of inner) {
      if (!child.startsWith(PART_DIR_PREFIX)) continue;
      const staging = path.join(dir, child);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      removed.push(staging);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

/**
 * Keyframe times for a copy-tier stream, cheapest source first: the cached
 * KeyframeIndex row, then the Matroska Cues reader (a few hundred KB), and
 * only then the whole-file ffprobe pass V4_PLAN.md warns is a scan-time job.
 * Whatever it took, the answer is written back so the next play -- and every
 * later seek in this one -- is a single indexed SELECT.
 *
 * The caller is expected to run this behind the one shared per-key promise
 * (see openStream): two simultaneous first plays of an unindexed file must
 * not both start a whole-file ffprobe.
 */
async function resolveKeyframes(source: ResolvedSource): Promise<number[]> {
  const cacheKey = { mtimeMs: source.mtimeMs, sizeBytes: BigInt(source.sizeBytes) };
  const cached = await loadKeyframeIndex(source.kind, source.id, cacheKey);
  if (cached) return cached.keyframeSecs;

  const cues = await getCuesKeyframes(source.absPath);
  if (cues) {
    await saveKeyframeIndex(source.kind, source.id, cacheKey, { keyframeSecs: cues.keyframeSecs, source: "cues" });
    return cues.keyframeSecs;
  }

  const probed = await getKeyframes(source.absPath);
  if (!probed) {
    // Copied video can only be cut on its own keyframes, and V4_PLAN.md is
    // explicit that the cut list is never guessed. A file whose keyframes
    // neither Cues nor ffprobe can name is broken, not slow.
    throw new PlaybackError("no-keyframes", `no keyframes could be read from ${path.basename(source.absPath)}`);
  }
  await saveKeyframeIndex(source.kind, source.id, cacheKey, probed);
  return probed.keyframeSecs;
}

// ---------------------------------------------------------------------------
// Opening a stream
// ---------------------------------------------------------------------------

/**
 * The tier a key runs at. "original" keeps the source's video only when the
 * planner says the codec survives as-is; "remote" is always a real encode,
 * whatever the source (head-args.ts's `doVideoCopy` makes the same call, and
 * both must agree -- the tier decides which segment table is built, and a
 * table built for the wrong one would be dictated to ffmpeg anyway).
 */
export function streamTier(source: ResolvedSource, variant: Variant): StreamTier {
  return variant === "original" && source.plan.videoAction === "copy" ? "copy" : "transcode";
}

function planIdentity(key: string, source: ResolvedSource, segments: SegmentEntry[]) {
  return {
    key,
    sourceMtimeMs: source.mtimeMs,
    sourceSizeBytes: source.sizeBytes,
    segmentCount: segments.length,
    tableHash: segmentTableHash(segments),
  };
}

async function readPlan(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, PLAN_FILE), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Prepare (or re-open) the directory for one stream key: compute the segment
 * table, and make sure what is on disk was produced from the same file
 * against the same table. Anything else -- a changed source, a rebuilt
 * keyframe index, a plan from an older layout -- means the existing segments
 * were cut differently, and mixing them with new ones is exactly the
 * corruption plan.json exists to prevent, so the whole directory goes.
 *
 * Expensive (a keyframe pass, a readdir) and must be single-flighted per key
 * by the caller; the engine keeps one promise per key for the life of the
 * process.
 */
export async function openStream(source: ResolvedSource, variant: Variant): Promise<StreamContext> {
  const key = buildStreamKey({ kind: source.kind, id: source.id, variant, audioStreamIndex: source.audioStreamIndex });
  const dir = streamDir(key);
  const tier = streamTier(source, variant);

  const keyframes = tier === "copy" ? await resolveKeyframes(source) : [];
  const segments =
    tier === "copy"
      ? segmentTableFromKeyframes(keyframes, source.durationSecs, HLS_SEGMENT_SECS)
      : fixedSegmentTable(source.durationSecs, HLS_SEGMENT_SECS);
  if (segments.length === 0) {
    throw new PlaybackError("not-playable", `${key} produced an empty segment table`);
  }

  const identity = planIdentity(key, source, segments);
  const stored = await readPlan(dir);
  if (stored !== null && isPlanStale(stored, identity)) {
    console.log(`[playback] ${key}: source or table changed, discarding cached segments`);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await fs.mkdir(dir, { recursive: true });
  if (stored === null || isPlanStale(stored, identity)) {
    const planFile: StreamPlanFile = { version: PLAN_VERSION, ...identity };
    await fs.writeFile(path.join(dir, PLAN_FILE), JSON.stringify(planFile));
  }

  // Leftover staging from a head this process no longer knows about (a
  // previous process's, since heads never outlive their engine).
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const present = new Set<number>();
  for (const name of names) {
    if (name.startsWith(PART_DIR_PREFIX)) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    const index = parseSegmentFileName(name);
    if (index !== null && index < segments.length) present.add(index);
  }

  return { key, dir, variant, tier, segments, keyframes, source, present };
}

/** Record a promoted segment and, when the table is finished, drop the
 *  `.complete` marker -- the signal that this stream never needs ffmpeg
 *  again (V4_PLAN.md: "a fully populated directory needs no ffmpeg at
 *  all"). */
export async function notePresent(ctx: StreamContext, index: number): Promise<void> {
  ctx.present.add(index);
  if (ctx.present.size < ctx.segments.length) return;
  await fs.writeFile(path.join(ctx.dir, COMPLETE_FILE), "").catch(() => {});
}

export function isStreamComplete(ctx: StreamContext): boolean {
  return ctx.present.size >= ctx.segments.length;
}

/** Whether a segment is really on disk. The in-memory set is the fast
 *  answer, but eviction can delete a whole directory between requests, so a
 *  positive is confirmed against the filesystem and a stale entry dropped. */
export async function segmentOnDisk(ctx: StreamContext, index: number): Promise<boolean> {
  const p = segmentPath(ctx.dir, index);
  if (!ctx.present.has(index)) return fileExists(p);
  if (await fileExists(p)) return true;
  ctx.present.delete(index);
  return false;
}
