// The v4 engine's judgement calls, pulled out as pure functions so they can
// be tested without a process, a disk or a database: which head serves a
// segment request (and whether one has to be restarted), when a head has
// run too far ahead of the viewer, when a head has caught up with output
// that already exists, which stream directories to evict, and whether a
// directory's plan.json still describes the file on disk.
//
// Everything with a side effect -- spawning, killing, renaming, deleting --
// lives in head.ts / stream-cache.ts / engine.ts and calls into here for the
// decision itself. Constants live here too, next to the reasoning for their
// values.

import { createHash } from "node:crypto";
import { selectEntriesToEvict, MIN_FREE_DISK_BYTES, type CacheEntry } from "@/lib/video-cache";
import type { StreamAction, Variant } from "@/lib/video-playback";
import type { SegmentEntry } from "./types";

/**
 * How a stream key's video is produced, which is what every timing constant
 * below scales with. "copy" is a stream copy (a remux -- tens of times
 * realtime, bounded by the share, not the CPU); "transcode" is a real
 * encode, which on the software path runs near realtime.
 */
export type StreamTier = "copy" | "transcode";

/**
 * The one rule for which tier a variant of a file runs at: "original" keeps
 * the source's video only when the planner says the codec survives as-is;
 * "remote" is always a real encode, whatever the source. Pulled out here
 * (rather than living only on stream.ts's streamTier, which needs a whole
 * ResolvedSource) so source.ts can ask the same question before a
 * ResolvedSource exists yet -- deciding whether an interlace measurement is
 * worth its cost needs exactly this, and only this.
 */
export function tierFor(variant: Variant, videoAction: StreamAction): StreamTier {
  return variant === "original" && videoAction === "copy" ? "copy" : "transcode";
}

// ---------------------------------------------------------------------------
// Segment request: serve / wait / restart (V4_PLAN.md, "Heads")
// ---------------------------------------------------------------------------

/**
 * How far *behind* the requested segment a live head may be and still be
 * worth waiting for, rather than starting a new head at the request.
 *
 * Transcode: 3 segments is ~18s of output. On the software path that is
 * roughly 18s of wall time for a 1080p source, which is already at the edge
 * of the bounded wait below -- anything further behind and restarting at the
 * request is strictly faster.
 *
 * Copy: a remux runs far faster than realtime (V4_PLAN.md measured ~260
 * MiB/s off the share), so a head 12 segments -- over a minute of video --
 * behind still gets there in a couple of seconds, and letting it run keeps
 * the segments in between (which the viewer is about to want) rather than
 * abandoning them.
 */
export const WAIT_AHEAD_TRANSCODE = 3;
export const WAIT_AHEAD_COPY = 12;

/**
 * What a key's segments are: MPEG-TS, or fragmented MP4 (a shared
 * `init.mp4` plus one `moof`/`mdat` media segment each) for copied HEVC.
 * AVPlayer quietly drops an HEVC video track carried in MPEG-TS -- the
 * audio plays over a black screen (Apple TV and Mac, 24 Sep 2026) -- and
 * Apple's HLS takes HEVC and HDR only as fMP4. Everything the engine
 * encodes is H.264, which MPEG-TS carries fine, so only a copy can need it.
 */
export type SegmentContainer = "ts" | "fmp4";

export function segmentContainerFor(variant: Variant, plan: { videoAction: StreamAction; hevcTag: boolean }): SegmentContainer {
  // hevcTag is exactly "the video is copied HEVC" (video-playback.ts).
  return variant === "original" && plan.videoAction === "copy" && plan.hevcTag ? "fmp4" : "ts";
}

export function waitAheadFor(tier: StreamTier): number {
  return tier === "copy" ? WAIT_AHEAD_COPY : WAIT_AHEAD_TRANSCODE;
}

/** A live head as the decision sees it: who started it, and the index it is
 *  about to write next (its start index until it has finished anything). */
export interface LiveHead {
  headId: string;
  sessionId: string;
  nextIndex: number;
}

export type SegmentDecision =
  /** The file is already on disk. */
  | { action: "serve" }
  /** Wait for this head to reach the index. */
  | { action: "wait"; headId: string }
  /** Start a head at the index, first stopping this session's own head on
   *  this stream if it has one (never another session's -- two viewers at
   *  different positions in the same file each keep their own head). */
  | { action: "start"; stopHeadId: string | null };

export interface SegmentDecisionInput {
  index: number;
  /** Whether seg_<index> already exists in the stream directory. */
  onDisk: boolean;
  /** Every live head on THIS stream, any session. */
  heads: LiveHead[];
  /** The requesting session. */
  sessionId: string;
  tier: StreamTier;
}

/**
 * The rule from V4_PLAN.md's "Heads": on disk -> serve; a live head close
 * enough behind -> wait for it; otherwise restart this session's head at the
 * request. Where several heads qualify, the closest one wins -- it is the
 * one that will get there first, and it is the one whose intermediate
 * segments are most likely already written.
 */
export function decideSegment(input: SegmentDecisionInput): SegmentDecision {
  if (input.onDisk) return { action: "serve" };

  const maxBehind = waitAheadFor(input.tier);
  const reachable = input.heads
    .filter((h) => h.nextIndex <= input.index && input.index - h.nextIndex <= maxBehind)
    .sort((a, b) => b.nextIndex - a.nextIndex);
  if (reachable.length > 0) return { action: "wait", headId: reachable[0].headId };

  const own = input.heads.find((h) => h.sessionId === input.sessionId) ?? null;
  return { action: "start", stopHeadId: own ? own.headId : null };
}

/**
 * How long a segment request waits before giving up. The route turns the
 * resulting typed error into 503 + Retry-After rather than holding the
 * connection open indefinitely: 30s is longer than any single segment takes
 * to produce on the software path and short enough that a wedged head shows
 * up as a retryable error instead of a hung player.
 */
export const SEGMENT_WAIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Catching up with cached output
// ---------------------------------------------------------------------------

/**
 * How many consecutive already-written segments ahead of a head mean it has
 * caught up with a previous run's output and should stop. One is not enough
 * -- a single existing segment can be a lone leftover from a seek -- and
 * three is a run long enough (18s+) that continuing would just be
 * re-encoding what is already there.
 */
export const CATCH_UP_LOOKAHEAD = 3;

/**
 * Whether a head that is about to write `nextIndex` should stop instead
 * because that segment and the CATCH_UP_LOOKAHEAD - 1 after it are already
 * on disk. Past the end of the table there is nothing left to write, which
 * also counts as caught up.
 */
export function isHeadCaughtUp(nextIndex: number, segmentCount: number, exists: (index: number) => boolean): boolean {
  if (nextIndex >= segmentCount) return true;
  for (let i = nextIndex; i < nextIndex + CATCH_UP_LOOKAHEAD && i < segmentCount; i++) {
    if (!exists(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Verifying a finished segment against the table
// ---------------------------------------------------------------------------

/**
 * A head writes the file the *table* named, or it writes nothing. The
 * failure this guards against is the one found on the VM (19 Sep 2026, fixed
 * at source in head-args.ts by widening `-segment_time_delta` for
 * transcodes): the segment muxer misses a cut, so one file comes out double
 * length and every later file is numbered one too low -- right filename,
 * wrong content, silently, for the rest of the film. Nothing downstream can
 * detect that; a player just sees the picture jump. So every completed
 * segment's reported duration is compared with the table's before the file
 * is renamed into place, and a mismatch stops the head instead of publishing
 * it.
 *
 * ## What the CSV numbers actually are
 *
 * Measured against ffmpeg 9.0.2 (Homebrew, 19 Sep 2026) for copy and
 * transcode heads started at 0, 1 and 2:
 *
 *   - Every entry *after* a head's first reports absolute source times
 *     (start and end), because `-copyts` plus `mpegts_copyts=1` keep the
 *     timeline absolute.
 *   - A head's FIRST entry reports `start = 0.000000` whatever index it
 *     started at -- the muxer's own initial value, not a timestamp -- while
 *     its `end` is absolute. A head restarted at segment 1 of a 2s table
 *     therefore prints `seg_00001.ts,0.000000,4.000000`: an apparent 4s
 *     duration for a 2s segment.
 *
 * So `end - start` is not, on its own, the duration. Two readings are
 * accepted, and a segment passes if either lands within tolerance:
 * `end - start` (both times in the same frame of reference, whichever it
 * is) and `end - table[index].start` (an absolute end against a start the
 * table already knows). A missed cut fails both, because its reported end
 * is the *next* boundary's.
 */
export const SEGMENT_DURATION_TOLERANCE_SECS = 0.25;

/**
 * Extra slack on the short side for a transcoded head's own first segment:
 * its first encoded frame is not exactly on the boundary (an accurate seek
 * can land a frame late, and a source's first pts is not always 0), so that
 * segment legitimately runs a little short. Currently inside the floor
 * above; kept explicit so the floor can be tightened without re-discovering
 * this.
 */
export const TRANSCODE_FIRST_SEGMENT_SHORTFALL_SECS = 0.1;

/** How far a reported duration may sit from the table's: a quarter second,
 *  or two frames where those are longer (a 12fps DVD-era oddity, or an
 *  animation frame-rate source). */
export function segmentDurationTolerance(fps: number | null): number {
  const twoFrames = fps !== null && Number.isFinite(fps) && fps > 0 ? 2 / fps : 0;
  return Math.max(SEGMENT_DURATION_TOLERANCE_SECS, twoFrames);
}

export interface SegmentDurationCheckInput {
  index: number;
  /** table[index].start and .duration. */
  expectedStart: number;
  expectedDuration: number;
  segmentCount: number;
  /** The CSV line's two numbers, verbatim. */
  reportedStart: number;
  reportedEnd: number;
  fps: number | null;
  tier: StreamTier;
  /** Whether this is the first segment this head produced. */
  isHeadFirstSegment: boolean;
}

export type SegmentDurationVerdict =
  | { ok: true }
  | { ok: false; reportedDuration: number; expectedDuration: number; tolerance: number };

/**
 * Whether a completed segment may be renamed into place. See the block
 * comment above for the two readings and why both are tried.
 *
 * The table's LAST segment is never checked. Its duration is "whatever
 * remains of the probed duration", which the container's own header can
 * disagree with by more than a tolerance would allow (video and audio rarely
 * end on the same frame), and the corruption this exists to catch -- a
 * missed cut renumbering everything after it -- is impossible there: a
 * missed cut is always detected at the boundary it skipped, which by
 * definition has segments after it.
 */
export function checkSegmentDuration(input: SegmentDurationCheckInput): SegmentDurationVerdict {
  if (input.index >= input.segmentCount - 1) return { ok: true };

  const tolerance = segmentDurationTolerance(input.fps);
  const shortfall =
    input.isHeadFirstSegment && input.tier === "transcode" ? TRANSCODE_FIRST_SEGMENT_SHORTFALL_SECS : 0;

  const candidates = [input.reportedEnd - input.reportedStart, input.reportedEnd - input.expectedStart];
  let best = candidates[0];
  for (const reported of candidates) {
    const delta = reported - input.expectedDuration;
    if (delta <= tolerance && -delta <= tolerance + shortfall) return { ok: true };
    if (Math.abs(delta) < Math.abs(best - input.expectedDuration)) best = reported;
  }
  return { ok: false, reportedDuration: best, expectedDuration: input.expectedDuration, tolerance };
}

// ---------------------------------------------------------------------------
// Run-ahead throttle (V4_PLAN.md, "Housekeeping")
// ---------------------------------------------------------------------------

/**
 * How far ahead of the newest request a head may run before it is paused
 * (SIGSTOP), and the lower watermark it is resumed (SIGCONT) at. V4_PLAN.md
 * puts these in minutes -- "~3 min (transcode) / ~10 min (remux)" -- which
 * at HLS_SEGMENT_SECS (6s) is 30 and 100 segments. Resuming at half the
 * pause watermark rather than at it stops a viewer sitting exactly on the
 * boundary from flapping SIGSTOP/SIGCONT once per segment.
 *
 * These are also what a live stream *costs in disk*, which is the other half
 * of the concurrency question: what the head has run ahead, plus what the
 * trim pass keeps behind the viewer (KEEP_BEHIND_SEGMENTS below). For a
 * Blu-ray remux at ~25 MB per 6s segment that is (100 + 20) x 25 MB ~= 3 GB
 * per live copy-tier stream in steady state, so the default two sessions
 * settle at ~6 GB of cache volume however long the film is. Raising
 * PLAYBACK_MAX_SESSIONS multiplies that figure.
 */
export const THROTTLE_AHEAD_TRANSCODE = 30;
export const THROTTLE_RESUME_TRANSCODE = 15;
export const THROTTLE_AHEAD_COPY = 100;
export const THROTTLE_RESUME_COPY = 50;

export function throttleWatermarks(tier: StreamTier): { pauseAt: number; resumeAt: number } {
  return tier === "copy"
    ? { pauseAt: THROTTLE_AHEAD_COPY, resumeAt: THROTTLE_RESUME_COPY }
    : { pauseAt: THROTTLE_AHEAD_TRANSCODE, resumeAt: THROTTLE_RESUME_TRANSCODE };
}

export interface ThrottleInput {
  /** The index the head is about to write. */
  nextIndex: number;
  /** The highest index any session has asked this stream for recently, or
   *  null when nothing has been requested yet (a pre-warming head). */
  highestRequested: number | null;
  paused: boolean;
  tier: StreamTier;
}

/** "pause", "resume", or null for leave it alone. */
export function throttleAction(input: ThrottleInput): "pause" | "resume" | null {
  // Nothing requested yet: the head is running for a session that hasn't
  // asked for a segment, so there is no gap to measure. Never pause on a
  // guess -- the first request arms this properly.
  if (input.highestRequested === null) return null;
  const gap = input.nextIndex - input.highestRequested;
  const { pauseAt, resumeAt } = throttleWatermarks(input.tier);
  if (!input.paused && gap > pauseAt) return "pause";
  if (input.paused && gap <= resumeAt) return "resume";
  return null;
}

// ---------------------------------------------------------------------------
// plan.json staleness
// ---------------------------------------------------------------------------

/** Bumped when the on-disk layout or the plan's own fields change shape, so
 *  an older deploy's directories are discarded rather than misread.
 *
 *  2 (interlace.ts): a transcoded segment cut under version 1 may have been
 *  needlessly deinterlaced by the old header-trusting rule, and nothing else
 *  in plan.json -- source mtime/size, the table hash -- moves when only the
 *  *decision* about a file changes underneath it. Bumping the version is the
 *  only way to invalidate those cached segments; they otherwise look exactly
 *  as fresh as ones cut under the corrected rule.
 *
 *  3 (video-playback.ts): AC-3 stopped being a codec we copy, so a segment
 *  cut under version 2 carries AC-3 audio while the master playlist -- built
 *  fresh from the current plan on every request -- now advertises the AAC
 *  those segments don't contain. The audio choice doesn't move the segment
 *  boundaries, so the table hash is identical and the directory looks clean.
 *  Chrome played the video in silence with the speaker greyed out; Safari
 *  hid it entirely by decoding the AC-3 anyway (22 Sep 2026). */
export const PLAN_VERSION = 3;

/** What `<key>/plan.json` holds: enough to prove the directory's segments
 *  were produced from the file that is on the share *now*, and against the
 *  same segment table the playlist will hand a player. */
export interface StreamPlanFile {
  version: number;
  key: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  segmentCount: number;
  /** Absent in a plan written before fMP4 existed: those were all "ts". */
  container?: SegmentContainer;
  /** Hash of the whole table, so a keyframe index that has been rebuilt
   *  differently (or a changed HLS_SEGMENT_SECS) invalidates the directory
   *  even when mtime/size haven't moved. */
  tableHash: string;
}

/** Stable digest of a segment table. Times are fixed to microseconds
 *  first: the table is rebuilt from the same inputs every time, but float
 *  formatting must not be what decides whether a cache hit happens. */
export function segmentTableHash(segments: SegmentEntry[]): string {
  const h = createHash("sha1");
  for (const s of segments) h.update(`${s.index}:${s.start.toFixed(6)}:${s.duration.toFixed(6)}\n`);
  return h.digest("hex");
}

export interface StreamPlanIdentity {
  key: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  segmentCount: number;
  container: SegmentContainer;
  tableHash: string;
}

/**
 * Whether a directory's stored plan still describes what would be produced
 * now. Anything but an exact match -- including an unreadable or
 * wrong-shaped file -- is stale: the directory holds segments cut from a
 * file that has since changed, and mixing those with new ones is exactly
 * the corruption the plan file exists to prevent.
 */
export function isPlanStale(stored: unknown, current: StreamPlanIdentity): boolean {
  if (typeof stored !== "object" || stored === null) return true;
  const p = stored as Partial<StreamPlanFile>;
  return (
    p.version !== PLAN_VERSION ||
    p.key !== current.key ||
    p.sourceMtimeMs !== current.sourceMtimeMs ||
    p.sourceSizeBytes !== current.sourceSizeBytes ||
    p.segmentCount !== current.segmentCount ||
    (p.container ?? "ts") !== current.container ||
    p.tableHash !== current.tableHash
  );
}

// ---------------------------------------------------------------------------
// Cache budget (V4_PLAN.md, "Housekeeping" -- "Budget")
// ---------------------------------------------------------------------------

/** One stream directory as the budget sees it. `atimeMs` is the LRU clock:
 *  the mtime of the directory's `.atime` marker, touched on every playlist
 *  and segment request (see stream-cache.ts for why a marker rather than
 *  the directory's own mtime). */
export interface StreamCacheEntry {
  key: string;
  path: string;
  size: number;
  atimeMs: number;
}

/**
 * Which stream directories to delete to get back under the byte budget,
 * least-recently-played first. Delegates to video-cache.ts's
 * selectEntriesToEvict -- the same accounting, the same "pinned entries
 * count toward the total but are never evicted" rule -- with pinning
 * decided here: a stream with a live head, or one a session has touched
 * within the idle window, is in use and must not be pulled out from under
 * a player mid-watch. Partial directories are ordinary entries, exactly as
 * V4_PLAN.md says.
 */
export function selectStreamsToEvict(
  entries: StreamCacheEntry[],
  limitBytes: number,
  isPinned: (key: string) => boolean,
): string[] {
  const asCacheEntries: CacheEntry[] = entries.map((e) => ({
    path: e.path,
    size: e.size,
    mtimeMs: e.atimeMs,
    pinned: isPinned(e.key),
  }));
  return selectEntriesToEvict(asCacheEntries, limitBytes);
}

// ===========================================================================
// Trimming played segments (V4_PLAN.md, "Housekeeping")
// ===========================================================================
//
// Whole-stream eviction above cannot help the case that actually fills the
// disk: the stream someone is *watching* is pinned, and a Blu-ray remux is
// ~25 MB per 6s segment -- ~27 GB for a film, on a volume with ~9 GB free.
// One pinned stream can exceed the entire byte budget on its own, so the
// budget says nothing about it and nothing ever removes the segments the
// viewer has already been through.
//
// So, under pressure only, a live stream gives up what is behind its
// viewers. Under no pressure nothing is trimmed, which keeps the property
// the plan is proud of: a small title caches whole and replays with no
// ffmpeg at all.

/**
 * How much of what a viewer has already watched is kept anyway: 20 segments
 * is two minutes at HLS_SEGMENT_SECS. That covers the back-buffer a player
 * re-requests after a bitrate or audio change, and a "skip back 30s" lands
 * inside it -- so the commonest rewind costs nothing, while a head is only
 * ever restarted for a genuine seek backwards.
 */
export const KEEP_BEHIND_SEGMENTS = 20;

/**
 * How far back a session's requests are looked at to decide where its
 * playhead is. Players fetch a little out of order and hls.js will re-request
 * a segment it already had, so the playhead is the MINIMUM index asked for in
 * this window rather than the latest: an in-flight earlier request must never
 * be trimmed out from under the response that is about to serve it.
 */
export const TRIM_PLAYHEAD_WINDOW_MS = 30_000;

/**
 * A segment requested within this long is never unlinked, whatever its index
 * and whoever asked for it. The engine hands a route a path and the route
 * opens it a moment later (serve-file.ts), so the file must outlive that gap
 * by a wide margin -- a minute is far longer than any request takes and
 * costs, at worst, one segment's worth of postponed reclamation.
 */
export const TRIM_RECENT_REQUEST_MS = 60_000;

/**
 * The free-disk level at which trimming starts even though the byte budget
 * is satisfied. MIN_FREE_DISK_BYTES is the point at which the engine refuses
 * to start heads at all; starting to reclaim only there would mean playback
 * has already stalled. Three times it leaves room for the heads currently
 * running to keep writing while the trim pass catches up.
 */
export const TRIM_FREE_DISK_LOW_WATER_BYTES = MIN_FREE_DISK_BYTES * 3;

/**
 * How far past the threshold a pass trims, as a fraction of it. Without this
 * a stream sitting exactly on the budget would trim a segment or two on every
 * 30s tick forever; with it, a pass buys roughly 10% of the budget's worth of
 * quiet before the next one has anything to do.
 */
export const TRIM_HYSTERESIS = 0.1;

/** How many bytes a trim pass has to reclaim: enough to get back under the
 *  byte budget, or enough to get free disk back above the low-water mark,
 *  whichever demands more -- plus the hysteresis overshoot. Zero means there
 *  is no pressure and nothing should be trimmed at all. `freeBytes` is null
 *  where the platform won't say (statfs failed), which is not evidence of a
 *  problem and so isn't treated as one. */
export function trimBytesNeeded(totalBytes: number, limitBytes: number, freeBytes: number | null): number {
  const overBudget = totalBytes > limitBytes ? totalBytes - limitBytes * (1 - TRIM_HYSTERESIS) : 0;
  const lowDisk =
    freeBytes !== null && freeBytes < TRIM_FREE_DISK_LOW_WATER_BYTES
      ? TRIM_FREE_DISK_LOW_WATER_BYTES * (1 + TRIM_HYSTERESIS) - freeBytes
      : 0;
  return Math.max(0, Math.ceil(Math.max(overBudget, lowDisk)));
}

/** One live stream as the trim pass sees it. */
export interface TrimCandidateStream {
  key: string;
  /** Every segment cached for this key, with the bytes it occupies. */
  segments: { index: number; bytes: number }[];
  /**
   * One playhead per LIVE session on this key (the same liveness rule the
   * session cap uses): the lowest index that session asked for within
   * TRIM_PLAYHEAD_WINDOW_MS, or its last requested index when it has been
   * quiet for longer than that (a paused player is still watching).
   * EMPTY when no session is live here -- an idle stream is whole-stream
   * eviction's business, not this pass's.
   */
  playheads: number[];
  /** Indices requested within TRIM_RECENT_REQUEST_MS, by any session. */
  recentIndices: number[];
}

export interface TrimInput {
  streams: TrimCandidateStream[];
  /** What the engine's stream directories hold now, after eviction. */
  totalBytes: number;
  limitBytes: number;
  freeBytes: number | null;
}

/** What to unlink from one stream, and what that buys. */
export interface StreamTrim {
  key: string;
  indices: number[];
  bytes: number;
}

function streamBytes(stream: TrimCandidateStream): number {
  return stream.segments.reduce((sum, s) => sum + s.bytes, 0);
}

/**
 * Which cached segments to unlink, and from where. The rule:
 *
 * - Nothing at all unless there is pressure (trimBytesNeeded).
 * - The largest live stream goes first: it is where the bytes are, and
 *   taking them from one stream leaves the others' rewind windows intact.
 * - A stream's protected range is [min(playheads) - KEEP_BEHIND_SEGMENTS,
 *   infinity): everything from a short rewind window behind the furthest-back
 *   viewer onward. Segments AHEAD are the head's run-ahead, which the
 *   throttle already bounds, and taking those would just make the head
 *   produce them again.
 * - A segment requested in the last TRIM_RECENT_REQUEST_MS is skipped
 *   whatever its index (it may be mid-response).
 * - Oldest index first, and only as far as the pressure demands.
 */
export function selectSegmentsToTrim(input: TrimInput): StreamTrim[] {
  let need = trimBytesNeeded(input.totalBytes, input.limitBytes, input.freeBytes);
  if (need <= 0) return [];

  const trims: StreamTrim[] = [];
  const largestFirst = [...input.streams].sort((a, b) => streamBytes(b) - streamBytes(a));

  for (const stream of largestFirst) {
    if (need <= 0) break;
    if (stream.playheads.length === 0) continue;

    const protectedFrom = Math.min(...stream.playheads) - KEEP_BEHIND_SEGMENTS;
    const recent = new Set(stream.recentIndices);
    const indices: number[] = [];
    let bytes = 0;

    for (const segment of [...stream.segments].sort((a, b) => a.index - b.index)) {
      if (need <= 0) break;
      // Sorted ascending, so the first protected index ends this stream.
      if (segment.index >= protectedFrom) break;
      if (recent.has(segment.index)) continue;
      indices.push(segment.index);
      bytes += segment.bytes;
      need -= segment.bytes;
    }

    if (indices.length > 0) trims.push({ key: stream.key, indices, bytes });
  }

  return trims;
}
