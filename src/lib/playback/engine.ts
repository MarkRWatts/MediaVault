// The v4 playback engine: sessions, segment requests, head lifecycle and the
// cache budget (V4_PLAN.md, "The engine" and "Housekeeping"). Everything
// with a decision in it lives in decisions.ts; everything with a process in
// it lives in head.ts; this module is what holds them together and is the
// only thing phase 4's routes talk to.
//
// ## One object on globalThis
//
// Every singleton here -- the per-key runtimes, the live heads, the
// sessions, the timers -- hangs off one object stashed on `globalThis`, the
// same pattern jellyfin-playback.ts uses for `__mvJfSessions`. Next's dev
// server hot-reloads a module by evaluating it again: a fresh module scope
// would get fresh, empty maps while the ffmpeg children started by the
// previous copy went on writing into the cache with nothing left that could
// kill them. Orphaned transcodes are the one failure this design cannot
// tolerate, so the state deliberately outlives the module.
//
// ## Serialised per stream
//
// Every decideSegment call for one key runs inside that key's own promise
// chain. Two players asking for the same missing segment at the same moment
// -- the ordinary case when a viewer seeks and the player fetches two
// segments at once -- must start ONE head between them, not two racing heads
// writing the same files. The lock is per key, so unrelated streams never
// wait on each other.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { onShutdown } from "@/lib/shutdown";
import { cacheDir, freeDiskBytes, maxCacheBytes, IDLE_CANCEL_MS, LEAVE_CANCEL_MS, MIN_FREE_DISK_BYTES } from "@/lib/video-cache";
import { REMOTE_AUDIO_BITRATE, REMOTE_VIDEO_MAXRATE, type Variant } from "@/lib/video-playback";
import {
  decideSegment,
  isHeadCaughtUp,
  selectSegmentsToTrim,
  selectStreamsToEvict,
  throttleAction,
  trimBytesNeeded,
  SEGMENT_WAIT_TIMEOUT_MS,
  TRIM_PLAYHEAD_WINDOW_MS,
  TRIM_RECENT_REQUEST_MS,
  type LiveHead,
  type StreamCacheEntry,
  type TrimCandidateStream,
} from "./decisions";
import { buildHeadArgs } from "./head-args";
import { startHead, type Head, type HeadStopReason } from "./head";
import { resolveHwAccel } from "./hwaccel";
import { hevcCodecString, hlsCodecs, renderMainPlaylist, renderMasterPlaylist, videoRangeFor } from "./playlist";
import { PlaybackError, resolveSource, transcodeReasonsFor, type PlaybackAudioTrack } from "./source";
import { buildStreamKey, parseStreamKey } from "./stream-key";
import {
  notePresent,
  openStream,
  readCachedSegments,
  readStreamCacheEntries,
  removeSegments,
  segmentOnDisk,
  segmentPath,
  streamDir,
  sweepStagingDirs,
  touchStream,
  type StreamContext,
} from "./stream";
import type { MediaKind, SegmentEntry } from "./types";

/** MPEG-TS, always (V4_PLAN.md, "Heads"). Exported so the route doesn't
 *  have to know the container to set a Content-Type. */
export const SEGMENT_CONTENT_TYPE = "video/mp2t";
export const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";

/** The media playlist's name, as the master playlist points at it. */
export const MAIN_PLAYLIST_NAME = "main.m3u8";

/**
 * Concurrent live streams, `PLAYBACK_MAX_SESSIONS` with `JELLYFIN_MAX_SESSIONS`
 * as a fallback for one release (V4_PLAN.md, "Removing Jellyfin": the new
 * name arrives, the old one leaves, and a deploy in between must not
 * silently jump to the default).
 */
export function maxSessions(): number {
  for (const raw of [process.env.PLAYBACK_MAX_SESSIONS, process.env.JELLYFIN_MAX_SESSIONS]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 2;
}

/** How many streams one viewer may hold at once (PLAYBACK_MAX_SESSIONS_PER_USER,
 *  default 2: the same person on a phone and a laptop). A viewer's identity
 *  here is their deviceId, which jf-viewer.ts derives per USER, so this is
 *  what lets one account play on two devices; each stream still counts
 *  toward maxSessions(). */
export function maxSessionsPerUser(): number {
  const n = Number(process.env.PLAYBACK_MAX_SESSIONS_PER_USER);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/** The 503 the clients already render verbatim -- kept character for
 *  character from jf-routes.ts so a viewer sees the same sentence before and
 *  after the cut-over. */
export function sessionCapMessage(max: number): string {
  return `Playback is limited to ${max} simultaneous stream${max === 1 ? "" : "s"} and ${
    max === 1 ? "it's" : "they're all"
  } in use right now — try again in a few minutes.`;
}

/** How recently a session must have been touched to count against the cap.
 *  A playing client asks for a segment every few seconds; hls.js stops
 *  asking once its buffer is full on pause, so the window has to be
 *  generous. Same three minutes jellyfin-playback.ts uses. */
const LIVE_WINDOW_MS = 3 * 60_000;

/** How often the budget is re-checked while heads are writing. A head can
 *  add a segment every fraction of a second on the copy tier, so the
 *  head-start check alone would let a long remux run far past the cap. */
const EVICTION_INTERVAL_MS = 30_000;

/** How many times a segment request will re-decide before giving up. Each
 *  pass either serves, waits for a head, or starts one; three is enough to
 *  cover "the head I was waiting for finished without reaching me" without
 *  letting a pathological stream start heads indefinitely. */
const MAX_SEGMENT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StreamRuntime {
  key: string;
  /** Single-flighted: one openStream per key for the life of the process. */
  ctx: Promise<StreamContext>;
  /** The per-key serial queue -- see the file header. */
  lock: Promise<unknown>;
  heads: Map<string, Head>;
  /** Highest index any session has asked this stream for, for the run-ahead
   *  throttle. null until the first request. */
  highestRequested: number | null;
  /** index -> when it was last asked for, by any session. The trim pass will
   *  not unlink anything in here that is younger than
   *  TRIM_RECENT_REQUEST_MS, whoever asked and whatever its index, because
   *  the route may be about to open the file (decisions.ts). Pruned by age,
   *  so it stays a handful of entries per live stream. */
  recentRequests: Map<number, number>;
}

interface Session {
  playSessionId: string;
  key: string;
  deviceId: string;
  touchedAtMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The last index this session asked for, or null before its first
   *  request: where a player that has gone quiet (a long pause, a full
   *  buffer) still counts as sitting. */
  lastIndex: number | null;
  /** This session's requests within TRIM_PLAYHEAD_WINDOW_MS, oldest first.
   *  Their minimum is the playhead the trim pass protects behind -- see
   *  decisions.ts for why the minimum rather than the latest. */
  recentRequests: { index: number; atMs: number }[];
}

interface EngineState {
  streams: Map<string, StreamRuntime>;
  sessions: Map<string, Session>;
  headsStarted: number;
  segmentsVerified: number;
  segmentMismatches: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  init: Promise<void> | null;
  shutdownInstalled: boolean;
}

const g = globalThis as unknown as { __mvPlaybackEngine?: EngineState };
const state: EngineState = (g.__mvPlaybackEngine ??= {
  streams: new Map(),
  sessions: new Map(),
  headsStarted: 0,
  segmentsVerified: 0,
  segmentMismatches: 0,
  evictionTimer: null,
  init: null,
  shutdownInstalled: false,
});

export interface EngineStats {
  /** Cumulative heads spawned since this process started -- what an
   *  integration test asserts a cold seek against. */
  headsStarted: number;
  liveHeads: number;
  pausedHeads: number;
  sessions: number;
  streams: number;
  /** Segments whose reported duration matched the table, and those that
   *  didn't (decisions.ts's checkSegmentDuration). A non-zero mismatch
   *  count means a head was killed rather than publishing bad output. */
  segmentsVerified: number;
  segmentMismatches: number;
}

export function engineStats(): EngineStats {
  let liveHeads = 0;
  let pausedHeads = 0;
  for (const rt of state.streams.values()) {
    for (const head of rt.heads.values()) {
      liveHeads++;
      if (head.paused) pausedHeads++;
    }
  }
  return {
    headsStarted: state.headsStarted,
    liveHeads,
    pausedHeads,
    sessions: state.sessions.size,
    streams: state.streams.size,
    segmentsVerified: state.segmentsVerified,
    segmentMismatches: state.segmentMismatches,
  };
}

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

function installShutdownHook(): void {
  if (state.shutdownInstalled) return;
  state.shutdownInstalled = true;
  onShutdown(() => {
    // Synchronous only: there is no time for a promise between the signal
    // and process exit (shutdown.ts). SIGKILL rather than SIGTERM because
    // nothing here will be around to notice a graceful exit, and a head
    // that outlived its engine is an orphan writing into the cache.
    for (const rt of state.streams.values()) {
      for (const head of rt.heads.values()) head.killNow();
    }
  });
}

/** Once per process: remove every staging directory left by a previous one.
 *  Heads never outlive their engine, so on a fresh process each `.part-*` is
 *  debris from a deploy or a crash. */
function ensureInit(): Promise<void> {
  if (!state.init) {
    installShutdownHook();
    state.init = sweepStagingDirs()
      .then((removed) => {
        if (removed.length > 0) console.log(`[playback] swept ${removed.length} leftover staging director${removed.length === 1 ? "y" : "ies"}`);
      })
      .catch(() => undefined);
  }
  return state.init;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

function ensureStream(key: string): StreamRuntime {
  const existing = state.streams.get(key);
  if (existing) return existing;

  const parts = parseStreamKey(key);
  if (!parts) throw new PlaybackError("not-found", `not a stream key: ${key}`);

  const rt: StreamRuntime = {
    key,
    ctx: (async () => {
      const source = await resolveSource(parts.kind, parts.id, parts.variant, parts.audioStreamIndex);
      if (!source) throw new PlaybackError("not-found", `no playable ${parts.kind} ${parts.id}`);
      return openStream(source, parts.variant);
    })(),
    lock: Promise.resolve(),
    heads: new Map(),
    highestRequested: null,
    recentRequests: new Map(),
  };
  // A stream that fails to open must not be cached as a permanent failure:
  // the share can come back, the file can be re-probed. Dropping it here
  // also marks the promise as handled, so a rejection nobody awaited (a
  // fire-and-forget prewarm) doesn't take the process down.
  rt.ctx.catch(() => {
    if (state.streams.get(key) === rt) state.streams.delete(key);
  });
  state.streams.set(key, rt);
  return rt;
}

/** Run `fn` with this stream's serial queue held. */
function withStreamLock<T>(rt: StreamRuntime, fn: () => Promise<T>): Promise<T> {
  const run = rt.lock.then(fn, fn);
  rt.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function liveHeadsOf(rt: StreamRuntime): LiveHead[] {
  return [...rt.heads.values()].map((h) => ({ headId: h.headId, sessionId: h.sessionId, nextIndex: h.nextIndex }));
}

// ---------------------------------------------------------------------------
// Housekeeping: throttle, budget, disk
// ---------------------------------------------------------------------------

function applyThrottle(rt: StreamRuntime, ctx: StreamContext): void {
  for (const head of rt.heads.values()) {
    const action = throttleAction({
      nextIndex: head.nextIndex,
      highestRequested: rt.highestRequested,
      paused: head.paused,
      tier: ctx.tier,
    });
    if (action === "pause") head.pause();
    else if (action === "resume") head.resume();
  }
}

/** A stream is pinned while a head is writing it, or while a session that
 *  could come back to it is still inside its idle window -- evicting either
 *  would pull the directory out from under a player mid-watch. */
function isStreamPinned(key: string, now: number): boolean {
  const rt = state.streams.get(key);
  if (rt && rt.heads.size > 0) return true;
  for (const s of state.sessions.values()) {
    if (s.key === key && now - s.touchedAtMs <= IDLE_CANCEL_MS) return true;
  }
  return false;
}

/** Whole-stream LRU eviction: idle directories go entirely. Returns the
 *  entries that survived, so the trim pass below can reason about what the
 *  cache holds *after* this without reading the disk a second time. */
async function evictStreams(entries: StreamCacheEntry[], now: number): Promise<StreamCacheEntry[]> {
  const victims = new Set(selectStreamsToEvict(entries, maxCacheBytes(), (key) => isStreamPinned(key, now)));
  for (const dir of victims) {
    const key = path.basename(dir);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    state.streams.delete(key);
    console.log(`[playback] evicted ${key}`);
  }
  return entries.filter((e) => !victims.has(e.path));
}

/** Where each live session on this key is sitting, as decisions.ts's trim
 *  selection wants it: the lowest index asked for in the recent window, or
 *  the last one asked for at all when the player has been quiet longer than
 *  that. A live session that has never requested a segment has no playhead
 *  and contributes none -- there is nothing behind it yet. */
function playheadsFor(key: string, now: number): number[] {
  const playheads: number[] = [];
  for (const session of liveSessions(now)) {
    if (session.key !== key) continue;
    const recent = session.recentRequests.filter((r) => now - r.atMs <= TRIM_PLAYHEAD_WINDOW_MS);
    if (recent.length > 0) playheads.push(Math.min(...recent.map((r) => r.index)));
    else if (session.lastIndex !== null) playheads.push(session.lastIndex);
  }
  return playheads;
}

/**
 * Trim what live viewers have already played (V4_PLAN.md, "Housekeeping").
 * Only under pressure -- the byte budget after eviction, or free disk below
 * the low-water mark -- so a small title still caches whole and replays with
 * no ffmpeg at all.
 *
 * `lockedKey` is the one stream whose per-key lock the caller already holds
 * (spawnHeadAt runs inside it): taking it again here would deadlock against
 * the caller that is waiting for us, and it is already serialised, which is
 * all the lock was for.
 */
async function trimPlayedSegments(entries: StreamCacheEntry[], now: number, lockedKey?: string): Promise<void> {
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const limitBytes = maxCacheBytes();
  const freeBytes = await freeDiskBytes(cacheDir());
  // Cheap check first: no pressure, no directory listing, no trim.
  if (trimBytesNeeded(totalBytes, limitBytes, freeBytes) <= 0) return;

  const cutoff = now - TRIM_RECENT_REQUEST_MS;
  const streams: TrimCandidateStream[] = [];
  for (const rt of state.streams.values()) {
    const playheads = playheadsFor(rt.key, now);
    if (playheads.length === 0) continue; // Idle: whole-stream eviction owns it.
    const segments = await readCachedSegments(streamDir(rt.key));
    if (segments.length === 0) continue;
    const recentIndices = [...rt.recentRequests].filter(([, atMs]) => atMs >= cutoff).map(([index]) => index);
    streams.push({ key: rt.key, segments, playheads, recentIndices });
  }

  for (const trim of selectSegmentsToTrim({ streams, totalBytes, limitBytes, freeBytes })) {
    const rt = state.streams.get(trim.key);
    if (!rt) continue;
    const apply = async () => {
      const ctx = await rt.ctx;
      const removed = await removeSegments(ctx, trim.indices);
      if (removed > 0) {
        console.log(
          `[playback] trimmed ${trim.key}: ${removed} segments (${(trim.bytes / 1024 ** 3).toFixed(1)} GB) behind the viewer`,
        );
      }
    };
    await (trim.key === lockedKey ? apply() : withStreamLock(rt, apply)).catch(() => {});
  }
}

/** One housekeeping pass: whole-stream LRU eviction for idle streams, then
 *  played-segment trimming for the live ones if that wasn't enough. */
async function runHousekeeping(now: number = Date.now(), lockedKey?: string): Promise<void> {
  const entries = await readStreamCacheEntries();
  const remaining = await evictStreams(entries, now);
  await trimPlayedSegments(remaining, now, lockedKey);
}

function startEvictionTimer(): void {
  if (state.evictionTimer) return;
  const timer = setInterval(() => {
    let live = false;
    for (const rt of state.streams.values()) if (rt.heads.size > 0) live = true;
    if (!live) {
      clearInterval(timer);
      if (state.evictionTimer === timer) state.evictionTimer = null;
      return;
    }
    void runHousekeeping().catch(() => {});
  }, EVICTION_INTERVAL_MS);
  timer.unref?.();
  state.evictionTimer = timer;
}

/**
 * Refuse to start a head that would fill the volume holding the SQLite
 * database. The byte budget is a retention policy (housekeeping has just
 * run); this is the actual safety net, the same division of labour
 * video-cache.ts makes. A head's total output isn't knowable up front -- it
 * stops wherever the viewer stops -- so there is nothing to subtract, only
 * headroom to insist on.
 *
 * Checked only AFTER a housekeeping pass has had its chance: the disk being
 * full of segments this engine wrote and could reclaim is the ordinary
 * case, and refusing to play with GBs of already-played remux sitting in the
 * cache is exactly the stall this pass exists to prevent.
 */
async function ensureDiskSpace(): Promise<void> {
  const free = await freeDiskBytes(cacheDir());
  if (free !== null && free < MIN_FREE_DISK_BYTES) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new PlaybackError(
      "no-disk-space",
      `Not enough disk space to play this file: the cache volume has ${gb(free)} GB free.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------

async function spawnHeadAt(rt: StreamRuntime, ctx: StreamContext, index: number, sessionId: string): Promise<Head> {
  await runHousekeeping(Date.now(), ctx.key).catch(() => {});
  await ensureDiskSpace();
  const hwaccel = await resolveHwAccel();
  const { source } = ctx;

  const head = await startHead({
    key: ctx.key,
    dir: ctx.dir,
    sessionId,
    startIndex: index,
    tier: ctx.tier,
    hwaccel,
    segments: ctx.segments,
    fps: source.facts.fps,
    onVerified: (ok) => {
      if (ok) state.segmentsVerified++;
      else state.segmentMismatches++;
    },
    buildArgs: (stagingDir) =>
      buildHeadArgs({
        input: source.absPath,
        plan: source.plan,
        variant: ctx.variant,
        audio: {
          streamIndex: source.audioStreamIndex,
          action: source.audioAction,
          sourceChannels: source.audioChannels,
        },
        segments: ctx.segments,
        startIndex: index,
        outDir: stagingDir,
        hwaccel,
        source: source.facts,
        keyframes: ctx.keyframes,
      }),
    onSegment: async (i) => {
      await notePresent(ctx, i);
      applyThrottle(rt, ctx);
    },
    shouldStop: (nextIndex) => isHeadCaughtUp(nextIndex, ctx.segments.length, (i) => ctx.present.has(i)),
  });

  state.headsStarted++;
  rt.heads.set(head.headId, head);
  void head.exited.then(() => rt.heads.delete(head.headId));
  startEvictionTimer();
  return head;
}

async function stopHeadsOfSession(playSessionId: string, reason: HeadStopReason): Promise<void> {
  const stops: Promise<void>[] = [];
  for (const rt of state.streams.values()) {
    for (const head of rt.heads.values()) {
      if (head.sessionId === playSessionId) stops.push(head.stop(reason));
    }
  }
  await Promise.all(stops);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface StartSessionInput {
  kind: MediaKind;
  id: number;
  variant: Variant;
  /** The player's Audio dropdown; omit or null for the planner's pick. */
  audioStreamIndex?: number | null;
  /** The viewer, as the Jellyfin path already derives it (jf-viewer.ts):
   *  per user, not per physical device. Holds up to maxSessionsPerUser(). */
  deviceId: string;
  /** The playSessionId this one supersedes (a quality/audio switch). Only
   *  honoured when it belongs to the same deviceId. */
  replaces?: string | null;
}

export interface StartedSession {
  playSessionId: string;
  key: string;
  durationSecs: number;
  transcodeReasons: string[];
  audioTracks: PlaybackAudioTrack[];
}

/** Session ids that own a head right now. */
function sessionsWithHeads(): Set<string> {
  const ids = new Set<string>();
  for (const rt of state.streams.values()) for (const head of rt.heads.values()) ids.add(head.sessionId);
  return ids;
}

/** Sessions that are actually streaming: touched within the live window, or
 *  with a head still writing for them. A paused-and-forgotten session stays
 *  resumable but holds no slot. Oldest touch first. */
function liveSessions(now: number): Session[] {
  const withHeads = sessionsWithHeads();
  return [...state.sessions.values()]
    .filter((s) => now - s.touchedAtMs <= LIVE_WINDOW_MS || withHeads.has(s.playSessionId))
    .sort((x, y) => x.touchedAtMs - y.touchedAtMs);
}

function armIdleTimer(session: Session, ms: number): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timer = setTimeout(() => {
    session.idleTimer = null;
    // The session survives: a viewer who paused for eleven minutes should
    // resume where they were, not re-negotiate. Only the head goes, and the
    // next segment request starts a new one at the right place.
    console.log(`[playback] session ${session.playSessionId} idle -- stopping its head`);
    void stopHeadsOfSession(session.playSessionId, "idle").catch(() => {});
  }, ms);
  timer.unref?.();
  session.idleTimer = timer;
}

/**
 * Start a playback session. Resolves the file, settles the segment table and
 * hands back the same five fields the Jellyfin session returns today
 * (jf-routes.ts) so the HTTP contract is unchanged.
 *
 * A session that names the one it `replaces` (a quality or audio switch)
 * takes its place; one viewer may hold maxSessionsPerUser() streams, and a
 * stream beyond the global cap is refused with a typed error carrying the
 * exact sentence the players already display.
 */
export async function startSession(input: StartSessionInput): Promise<StartedSession> {
  await ensureInit();

  const source = await resolveSource(input.kind, input.id, input.variant, input.audioStreamIndex ?? null);
  if (!source) throw new PlaybackError("not-found", `no playable ${input.kind} ${input.id}`);

  // A quality or audio switch names the session it replaces, so the old
  // one is gone before anything is counted -- the player's own POST /stop
  // is fire-and-forget and may well arrive after this request.
  if (input.replaces && sessionBelongsTo(input.replaces, input.deviceId)) await stopSession(input.replaces);

  // One viewer, a bounded number of streams: beyond that the stalest of
  // their own goes (a third device, or a client that never said what it
  // was replacing), never someone else's.
  const perUser = maxSessionsPerUser();
  const own = liveSessions(Date.now()).filter((x) => x.deviceId === input.deviceId);
  for (const stale of own.slice(0, Math.max(0, own.length - (perUser - 1)))) await stopSession(stale.playSessionId);

  const max = maxSessions();
  if (liveSessions(Date.now()).length >= max) {
    throw new PlaybackError("session-cap", sessionCapMessage(max));
  }

  const key = buildStreamKey({
    kind: source.kind,
    id: source.id,
    variant: input.variant,
    audioStreamIndex: source.audioStreamIndex,
  });
  const rt = ensureStream(key);
  const ctx = await rt.ctx;
  touchStream(ctx.dir);

  const playSessionId = randomBytes(16).toString("hex");
  const session: Session = {
    playSessionId,
    key,
    deviceId: input.deviceId,
    touchedAtMs: Date.now(),
    idleTimer: null,
    lastIndex: null,
    recentRequests: [],
  };
  state.sessions.set(playSessionId, session);
  armIdleTimer(session, IDLE_CANCEL_MS);

  console.log(
    `[playback] session ${playSessionId} ${key} (${ctx.tier}, ${ctx.segments.length} segments, ${source.durationSecs.toFixed(0)}s)`,
  );

  return {
    playSessionId,
    key,
    durationSecs: source.durationSecs,
    transcodeReasons: transcodeReasonsFor(source.plan, input.variant),
    audioTracks: source.audioTracks,
  };
}

/** Every playlist and segment request counts as the viewer still being
 *  there: it re-arms the idle window and keeps the session off the cap's
 *  "gone" list. Unknown ids are ignored -- a request whose session the
 *  process forgot across a restart still serves from the directory. */
export function touchSession(playSessionId: string): void {
  const session = state.sessions.get(playSessionId);
  if (!session) return;
  session.touchedAtMs = Date.now();
  armIdleTimer(session, IDLE_CANCEL_MS);
}

/** POST stop: the viewer closed the player. Kills the session's head now
 *  rather than at the idle timeout, and waits for it so the caller knows the
 *  process is really gone. */
export async function stopSession(playSessionId: string): Promise<void> {
  const session = state.sessions.get(playSessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  state.sessions.delete(playSessionId);
  await stopHeadsOfSession(playSessionId, "stopped");
}

/**
 * A viewer's "I'm leaving" beacon (video-cache.ts's noteViewerLeft): shrink
 * the idle window rather than stopping now, so a quality switch or a
 * navigation that comes straight back doesn't throw the head away, while a
 * genuine close doesn't leave one encoding for ten minutes. Returns whether
 * there was a session to shorten.
 */
export function noteViewerLeft(playSessionId: string): boolean {
  const session = state.sessions.get(playSessionId);
  if (!session) return false;
  armIdleTimer(session, LEAVE_CANCEL_MS);
  return true;
}

/**
 * Ownership check for the HTTP routes (phase 4's engine-routes.ts): whether
 * `playSessionId` is a session THIS device started, and -- when `key` is
 * given -- whether it is that session's own stream key. A route must not
 * let one viewer's session read another device's segments, or a film
 * route serve an episode's (or a different film's) key just because the
 * caller can guess or replay a session id; this is the local engine's
 * answer to what jellyfin-playback.ts's `lookupPlaybackSession` already
 * checks for the Jellyfin proxy. A session belongs to exactly one stream
 * key for its whole life -- a quality or audio switch starts a new session
 * (startSession) rather than repointing an old one.
 */
export function sessionBelongsTo(playSessionId: string, deviceId: string, key?: string): boolean {
  const session = state.sessions.get(playSessionId);
  if (!session || session.deviceId !== deviceId) return false;
  return key === undefined || session.key === key;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/** Rough bitrate for the master playlist's BANDWIDTH. Remote is a known
 *  ceiling; Original is the source's own average, which is what a copied
 *  rendition actually delivers. */
function bandwidthFor(ctx: StreamContext): number {
  if (ctx.variant === "remote") {
    return Number.parseFloat(REMOTE_VIDEO_MAXRATE) * 1_000_000 + Number.parseFloat(REMOTE_AUDIO_BITRATE) * 1_000;
  }
  return Math.max(1, Math.round((ctx.source.sizeBytes * 8) / ctx.source.durationSecs));
}

/** The dimensions the rendition will actually carry. Remote scales to 720p
 *  without ever upscaling, exactly as head-args.ts's filter does. */
function resolutionFor(ctx: StreamContext): { width: number; height: number } | undefined {
  const { width, height } = ctx.source.facts;
  if (width <= 0 || height <= 0) return undefined;
  if (ctx.variant !== "remote") return { width, height };
  const outHeight = Math.min(720, height);
  if (outHeight === height) return { width, height };
  // -2 in the scale filter means "keep the aspect ratio, round to even".
  const outWidth = Math.max(2, Math.round((width * outHeight) / height / 2) * 2);
  return { width: outWidth, height: outHeight };
}

/** Every playlist request is the viewer still being there, exactly as a
 *  segment request is -- a player that has buffered ahead may go a while
 *  without asking for either, and the idle timer must not read a playlist
 *  refresh as silence. */
async function contextFor(key: string, playSessionId?: string): Promise<StreamContext> {
  await ensureInit();
  const rt = ensureStream(key);
  const ctx = await rt.ctx;
  touchStream(ctx.dir);
  if (playSessionId) touchSession(playSessionId);
  return ctx;
}

/** `master.m3u8` for a key. `mainUri` is what the route serves the media
 *  playlist at, relative to the master -- the engine never constructs URLs. */
export async function getMasterPlaylist(
  key: string,
  mainUri: string = MAIN_PLAYLIST_NAME,
  playSessionId?: string,
): Promise<string> {
  const ctx = await contextFor(key, playSessionId);
  const videoCodec = ctx.variant === "remote" ? "h264" : ctx.source.plan.outputVideoCodec;
  const audioCodec = ctx.variant === "remote" ? (ctx.source.audioCodec === null ? null : "aac") : ctx.source.audioCodec;
  // Copied video is the source's own picture, HDR and bit depth included;
  // anything the engine encodes is 8-bit SDR H.264.
  const copied = ctx.variant === "original" && ctx.source.plan.videoAction === "copy";
  let codecs = hlsCodecs(videoCodec, audioCodec);
  if (copied && (videoCodec === "hevc" || videoCodec === "h265")) {
    codecs = [hevcCodecString(ctx.source.facts), ...codecs.split(",").slice(1)].join(",");
  }
  return renderMasterPlaylist({
    bandwidth: bandwidthFor(ctx),
    resolution: resolutionFor(ctx),
    codecs,
    videoRange: copied ? videoRangeFor(ctx.source.facts.colorTransfer) : undefined,
    mainUri,
  });
}

/** `main.m3u8` for a key: the whole VOD table, complete from the first
 *  request whether or not a single segment exists yet. */
export async function getMainPlaylist(key: string, playSessionId?: string): Promise<string> {
  const ctx = await contextFor(key, playSessionId);
  return renderMainPlaylist(ctx.segments);
}

/** The segment table itself, for a caller that wants the numbers rather
 *  than the playlist text (tests, and phase 4's progress reporting). */
export async function getSegmentTable(key: string): Promise<SegmentEntry[]> {
  return (await contextFor(key)).segments;
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export interface GetSegmentOptions {
  signal?: AbortSignal;
}

/** How many indices one stream remembers having been asked for. A live
 *  player asks for a handful per TRIM_RECENT_REQUEST_MS; this only bounds
 *  what a pathological client (or a very long seek-happy session) can make
 *  the engine hold, and expired entries go first. */
const MAX_RECENT_REQUESTS = 256;

/**
 * Record a segment request: where its session is sitting, and that this
 * index has just been asked for. Both feed the trim pass -- the first says
 * what is "behind the viewer", the second is what keeps a file that a
 * response is about to open from being unlinked under it (decisions.ts).
 *
 * The stream-level note is deliberately made for sessions this process
 * doesn't know (one that survived a restart): it can't say where such a
 * viewer is, but it can still refuse to delete what they just asked for.
 */
function noteRequest(rt: StreamRuntime, playSessionId: string, index: number, now: number): void {
  rt.recentRequests.set(index, now);
  if (rt.recentRequests.size > MAX_RECENT_REQUESTS) {
    const cutoff = now - TRIM_RECENT_REQUEST_MS;
    for (const [i, atMs] of rt.recentRequests) if (atMs < cutoff) rt.recentRequests.delete(i);
  }

  const session = state.sessions.get(playSessionId);
  if (!session) return;
  session.lastIndex = index;
  session.recentRequests.push({ index, atMs: now });
  while (session.recentRequests.length > 0 && now - session.recentRequests[0].atMs > TRIM_PLAYHEAD_WINDOW_MS) {
    session.recentRequests.shift();
  }
}

/**
 * The absolute path of one segment, producing it if necessary
 * (V4_PLAN.md, "Heads" -- serve / wait / restart). Bounded by
 * SEGMENT_WAIT_TIMEOUT_MS: a request that can't be satisfied in that time
 * becomes a typed timeout the route turns into a retryable 503 rather than a
 * connection held open until the player gives up on its own.
 */
export async function getSegment(
  key: string,
  index: number,
  playSessionId: string,
  options: GetSegmentOptions = {},
): Promise<string> {
  await ensureInit();
  const rt = ensureStream(key);
  const ctx = await rt.ctx;

  if (!Number.isInteger(index) || index < 0 || index >= ctx.segments.length) {
    throw new PlaybackError("not-found", `segment ${index} is outside ${key}'s table of ${ctx.segments.length}`);
  }

  touchStream(ctx.dir);
  touchSession(playSessionId);
  noteRequest(rt, playSessionId, index, Date.now());
  rt.highestRequested = rt.highestRequested === null ? index : Math.max(rt.highestRequested, index);
  applyThrottle(rt, ctx);

  const deadline = Date.now() + SEGMENT_WAIT_TIMEOUT_MS;
  for (let attempt = 0; attempt < MAX_SEGMENT_ATTEMPTS; attempt++) {
    if (await segmentOnDisk(ctx, index)) return segmentPath(ctx.dir, index);

    // One decision at a time per stream: see the file header.
    const head = await withStreamLock(rt, async (): Promise<Head | null> => {
      if (await segmentOnDisk(ctx, index)) return null;
      const decision = decideSegment({
        index,
        onDisk: false,
        heads: liveHeadsOf(rt),
        sessionId: playSessionId,
        tier: ctx.tier,
      });
      if (decision.action === "serve") return null;
      if (decision.action === "wait") return rt.heads.get(decision.headId) ?? null;
      if (decision.stopHeadId) {
        const own = rt.heads.get(decision.stopHeadId);
        if (own) await own.stop("replaced");
      }
      return spawnHeadAt(rt, ctx, index, playSessionId);
    });

    if (head) await head.waitFor(index, deadline, options.signal);
    if (await segmentOnDisk(ctx, index)) return segmentPath(ctx.dir, index);
    if (Date.now() >= deadline) break;
  }

  throw new PlaybackError("timeout", `segment ${index} of ${key} was not produced in time`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Tests only: run one housekeeping pass (eviction, then the trim) now,
 * instead of waiting for the 30s tick.
 *
 * `now` lets a test move the clock forward rather than sleep through the
 * request windows: walking a viewer through forty segments takes a test a
 * second, so every one of those requests is still "recent" and the playhead
 * is still at 0 -- which is correct, and useless for exercising what happens
 * four minutes into a film.
 */
export async function runHousekeepingForTest(now: number = Date.now()): Promise<void> {
  await runHousekeeping(now);
}

/** Tests only: stop everything and forget it, so a test that manipulates the
 *  cache directory behind the engine's back gets a genuinely cold start.
 *  The counters engineStats reports are deliberately *not* reset -- a test
 *  measures heads started across a reset, as a delta. */
export async function resetEngineForTest(): Promise<void> {
  for (const session of state.sessions.values()) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
  }
  state.sessions.clear();
  const stops: Promise<void>[] = [];
  for (const rt of state.streams.values()) {
    for (const head of rt.heads.values()) stops.push(head.stop("stopped"));
  }
  await Promise.all(stops);
  state.streams.clear();
  if (state.evictionTimer) clearInterval(state.evictionTimer);
  state.evictionTimer = null;
  state.init = null;
}
