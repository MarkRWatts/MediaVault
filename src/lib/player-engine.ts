// The app-wide gapless music engine. Web Audio API, not <audio>/MSE — a
// plain <audio> element re-buffers and re-decodes at every track boundary
// (an audible gap even for back-to-back files), where scheduling
// AudioBufferSourceNodes at exact sample-accurate AudioContext times gives
// a true gapless join. See PLAN.md "Playback" for why this exists and
// src/lib/audio-stream.ts for what /api/audio/<id> actually serves (a raw
// PCM stream at this context's sample rate).
//
// This used to live inside the album page's AlbumPlayer component, one
// engine per page visit. It is now a single instance for the life of the
// page (components/player/PlayerProvider.tsx owns it), fed a queue of
// arbitrary tracks — several albums, a playlist, favourites — so playback
// survives client-side navigation. Framework-free on purpose: the two
// browser touch-points (AudioContext construction, the streaming fetch)
// are injected through EngineDeps, which is what lets player-engine.test.ts
// drive it with a fake clock and no network.
//
// Queue model: `queue` is every entry in insertion order (the natural
// order shuffle restores); `order` is the entry keys in play order; every
// internal map (in-flight/finished loads, live source nodes, schedule
// anchors) is keyed by QueueEntry.key — an engine-assigned id unique per
// enqueue. Positions shift on every edit and one track can sit in the
// queue twice, so neither is a usable key.
//
// Streaming model: a track arrives as a sequence of short PCM chunks (half
// a second each, see streamTrack) rather than one decoded buffer. Each
// chunk becomes its own AudioBufferSourceNode, started at
// anchor.startAt + (seconds of audio before it) — the same sample-accurate
// arithmetic that joins one track to the next, just applied every half
// second within a track. The point is that playback starts as soon as the
// FIRST chunk lands (~100 ms after the click on the LAN) instead of after
// the whole file has downloaded and decoded, which is what decodeAudioData
// forced before and what made every track begin with a visible download.
// A chunk that arrives after its slot has already passed (a stalled
// network) shifts the anchor forward by the shortfall — playback resumes
// where it left off, like a buffering player, rather than skipping audio.
//
// Scheduling model: every entry's playback is described by an anchor
// { startAt, duration, complete } in `schedule`. startAt is an absolute
// AudioContext.currentTime coordinate; duration is the DB estimate until
// the stream finishes and the real total is known (`complete`), which is
// what makes the join sample-accurate. A successor only chains onto its
// predecessor's anchor once that anchor is complete — until then the
// end time isn't known — so a track's chunks can pile up decoded and
// waiting; the moment the predecessor completes they're scheduled. A
// track that fails to load leaves a zero-duration passthrough anchor
// instead of a real one, so the chain still advances past it
// (console.warn'd) rather than stalling.
//
// Prefetch pacing is driven by PLAYBACK, not by download completion:
// the current entry's successor is requested once the current entry's
// own stream has completed (which on the LAN is about a second in), and
// handleTrackEnded triggers the next prefetch as playback advances.
// Without that gate the stream→schedule→stream cascade would race through
// the whole queue, holding every decoded track at once (~1.5 GB of PCM
// for a 20-track album) and competing for bandwidth with the track that
// is actually playing. With it, at most two tracks are alive (current +
// next), and `loads` is pruned down to just the current entry as soon as
// playback advances past a track. Queue edits (play next, add, remove,
// move, reshuffle) all funnel through rechainAfterCurrent(), which tears
// down everything scheduled beyond the current entry and re-pulls the new
// successor — so the invariant holds however the queue is rearranged
// mid-play, and a load that is no longer current-or-next is aborted (see
// wanted()).

import {
  DEFAULT_VOLUME,
  EMPTY_SNAPSHOT,
  type PlaybackContext,
  type PlayerLoadError,
  type PlayerLoadProgress,
  type PlayerSnapshot,
  type PlayerStatus,
  type QueueEntry,
  type QueueTrack,
} from "@/lib/player-types";
import { PcmChunker, parseEstimatedBytes, parsePcmFormat } from "@/lib/pcm-chunks";

export interface TrackStreamHandlers {
  /** Called once per consecutive slice of the track, in order, each an
   *  AudioBuffer ready to schedule. */
  onChunk: (chunk: AudioBuffer) => void;
  /** Called repeatedly while the fetch is in flight, if given. */
  onProgress?: (p: PlayerLoadProgress) => void;
}

export interface EngineDeps {
  /** Construct the one AudioContext. Only ever called from a user gesture
   *  (Play) — autoplay policy requires it. */
  createContext: () => AudioContext;
  /** Stream one track: deliver every chunk through handlers.onChunk, then
   *  resolve once the last one has been delivered (reject on failure —
   *  including a failure part-way through, after some chunks). The
   *  default hits /api/audio/<id> for raw PCM at ctx's sample rate. The
   *  signal fires when the engine no longer wants the track. */
  loadTrack: (ctx: AudioContext, trackId: number, handlers: TrackStreamHandlers, signal: AbortSignal) => Promise<void>;
}

interface ScheduleInfo {
  startAt: number;
  /** Real total once `complete`; the DB estimate (or 0) before that. */
  duration: number;
  complete: boolean;
}

/** One track's arrival, from first request to last chunk. */
interface TrackLoad {
  chunks: AudioBuffer[];
  /** Seconds of audio before chunks[i] — its start offset within the track. */
  offsets: number[];
  /** Seconds of audio received so far. */
  totalSecs: number;
  complete: boolean;
  /** Highest chunk index whose source has already fired onended — for the
   *  race where the final chunk finishes playing before the stream's own
   *  completion is known. */
  lastEndedIndex: number;
  abort: AbortController;
}

// Lead-in for any start placed at "now" (a cold start's first chunk, a
// seek, a late chunk). Starting exactly at ctx.currentTime can race the
// audio hardware clock and clip the first samples; and since every later
// chunk of a track is laid on the timeline relative to this one, a first
// chunk that begins even a few ms late overlaps its successor for those
// few ms — an audible burst of static (reported on cold starts at 50 ms,
// 2026-09-10). 100 ms is still well inside "instant".
const START_EPSILON = 0.1;

// Sentinel key for "no predecessor" anchors in `schedule` — real entry
// keys start at 1, so -1 never collides with one.
const NO_PREDECESSOR = -1;

// "Previous" restarts the current track once it's this far in, and only
// steps back to the previous entry before that — the convention every
// player follows.
const PREVIOUS_RESTART_SECS = 3;

// One retry on a 503 from /api/audio (every ffmpeg slot taken — see
// AUDIO_BUSY in src/lib/audio-stream.ts) before giving up.
const MAX_RETRY_AFTER_MS = 15_000;

// How much audio goes into each chunk. Half a second is ~88 KB of 16-bit
// stereo — a few ms on the LAN, a couple of hundred ms on a slow mobile
// link — so it bounds the time-to-first-sound without making a 5-minute
// track into thousands of source nodes.
const CHUNK_SECS = 0.5;

// How long a cold start waits for AudioContext.resume() before scheduling
// anyway (see awaitClock).
const CLOCK_READY_TIMEOUT_MS = 1000;

async function fetchWithRetry(url: string, signal: AbortSignal): Promise<Response> {
  let res = await fetch(url, { signal });
  if (res.status === 503) {
    const secs = Number(res.headers.get("Retry-After"));
    const ms = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : 2000;
    await new Promise((r) => setTimeout(r, ms));
    res = await fetch(url, { signal });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** The production loadTrack: stream raw PCM from /api/audio/<id> at the
 *  context's sample rate, handing back an AudioBuffer per CHUNK_SECS of
 *  audio as the bytes arrive (see src/lib/pcm-chunks.ts). */
export async function streamTrack(
  ctx: AudioContext,
  trackId: number,
  handlers: TrackStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetchWithRetry(`/api/audio/${trackId}?rate=${Math.round(ctx.sampleRate)}`, signal);
  const format = parsePcmFormat(res.headers);
  if (!format || !res.body) throw new Error("not a PCM stream");
  const total = parseEstimatedBytes(res.headers);
  const chunker = new PcmChunker(format, Math.round(format.sampleRate * CHUNK_SECS));

  const emit = (planes: Float32Array[]) => {
    const frames = planes[0]?.length ?? 0;
    if (frames === 0) return;
    const buffer = ctx.createBuffer(format.channels, frames, format.sampleRate);
    planes.forEach((plane, c) => buffer.getChannelData(c).set(plane));
    handlers.onChunk(buffer);
  };

  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    handlers.onProgress?.({ loaded, total });
    for (const planes of chunker.push(value)) emit(planes);
  }
  const tail = chunker.flush();
  if (tail) emit(tail);
}

function defaultCreateContext(): AudioContext {
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor();
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class PlayerEngine {
  private readonly deps: EngineDeps;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;

  private readonly loads = new Map<number, TrackLoad>();
  /** Live source nodes per entry, by chunk index. */
  private readonly sources = new Map<number, Map<number, AudioBufferSourceNode>>();
  private readonly schedule = new Map<number, ScheduleInfo>();
  /** Bumped on every hard restart; a source's onended from an older
   *  session is ignored. Loads are validated by identity instead (see
   *  isLiveLoad) so an in-flight stream survives a restart onto itself. */
  private session = 0;
  /** False from a hard restart until the context's resume() has resolved
   *  — i.e. the audio device is actually running and currentTime is
   *  ticking. Nothing is anchored before then (see awaitClock). */
  private clockRunning = false;
  private nextEntryKey = 1;

  private queue: QueueEntry[] = [];
  private order: number[] = [];
  private currentKey: number | null = null;
  private status: PlayerStatus = "idle";
  private duration: number | null = null;
  private shuffle = false;
  private repeat = false;
  private volume = DEFAULT_VOLUME;
  private context: PlaybackContext | null = null;
  private lastError: PlayerLoadError | null = null;
  private loadProgress: PlayerLoadProgress | null = null;

  private readonly listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot = EMPTY_SNAPSHOT;

  constructor(deps: Partial<EngineDeps> = {}) {
    this.deps = {
      createContext: deps.createContext ?? defaultCreateContext,
      loadTrack: deps.loadTrack ?? streamTrack,
    };
  }

  // ---------------------------------------------------------------------
  // Store interface (useSyncExternalStore)
  // ---------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between mutations — a new object only when something changed. */
  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private emit() {
    const current = this.currentKey == null ? null : (this.entry(this.currentKey) ?? null);
    this.snapshot = {
      status: this.status,
      queue: this.queue,
      order: this.order,
      currentKey: this.currentKey,
      current,
      duration: this.duration,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      context: this.context,
      lastError: this.lastError,
      loadProgress: this.loadProgress,
    };
    for (const listener of this.listeners) listener();
  }

  /** Dismiss the current load-error banner. Does nothing once a later
   *  successful schedule has already cleared it. */
  dismissError = () => {
    if (!this.lastError) return;
    this.lastError = null;
    this.emit();
  };

  // ---------------------------------------------------------------------
  // Queue helpers
  // ---------------------------------------------------------------------

  private entry(key: number): QueueEntry | undefined {
    return this.queue.find((e) => e.key === key);
  }

  private orderIndex(key: number): number {
    return this.order.indexOf(key);
  }

  private nextKey(key: number | null): number | null {
    if (key == null) return null;
    const pos = this.orderIndex(key);
    if (pos === -1 || pos + 1 >= this.order.length) return null;
    return this.order[pos + 1];
  }

  private prevKey(key: number): number | null {
    const pos = this.orderIndex(key);
    if (pos <= 0) return null;
    return this.order[pos - 1];
  }

  /** Is `key`'s audio still worth holding? Only the current entry and its
   *  successor ever are — anything else is a load that was overtaken by a
   *  queue edit. */
  private wanted(key: number): boolean {
    return key === this.currentKey || key === this.nextKey(this.currentKey);
  }

  private makeEntries(tracks: QueueTrack[]): QueueEntry[] {
    return tracks.map((t) => ({ ...t, key: this.nextEntryKey++ }));
  }

  // ---------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const ctx = this.deps.createContext();
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
    }
    return this.ctx;
  }

  private stopSource(key: number) {
    const nodes = this.sources.get(key);
    if (!nodes) return;
    for (const source of nodes.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped/never started — fine to ignore.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore.
      }
    }
    this.sources.delete(key);
  }

  private stopAllSources() {
    for (const key of [...this.sources.keys()]) this.stopSource(key);
  }

  private hasLiveSource(key: number): boolean {
    return (this.sources.get(key)?.size ?? 0) > 0;
  }

  /** Abort and forget every load except `keepKey`'s. */
  private dropLoadsExcept(keepKey: number | null) {
    for (const [key, load] of [...this.loads]) {
      if (key === keepKey) continue;
      load.abort.abort();
      this.loads.delete(key);
    }
  }

  /** Abort and forget every load that is no longer current-or-next. */
  private dropUnwantedLoads() {
    for (const [key, load] of [...this.loads]) {
      if (this.wanted(key)) continue;
      load.abort.abort();
      this.loads.delete(key);
    }
  }

  /** Bring `key`'s successor in: chain it if its audio is already here
   *  (or arriving), request it otherwise. */
  private pullSuccessor(key: number, session: number) {
    const next = this.nextKey(key);
    if (next == null) return;
    if (this.loads.has(next)) this.maybeChain(next, session);
    else this.prefetch(next);
  }

  /** A load's callbacks may fire long after the engine has moved on; only
   *  the load object still registered under its key is the live one. */
  private isLiveLoad(key: number, load: TrackLoad): boolean {
    return this.loads.get(key) === load;
  }

  // Put chunk `index` of `key` on the timeline at anchor.startAt + its
  // offset. If that slot has already gone by (the stream fell behind
  // playback, or this is the current entry's very first chunk landing a
  // beat after the seed anchor was laid down), the whole anchor shifts
  // forward by the shortfall so the chunk starts now and everything after
  // it stays contiguous — the audible result is a pause, not a skip.
  private scheduleChunk(key: number, index: number, session: number) {
    const ctx = this.ctx;
    const info = this.schedule.get(key);
    const load = this.loads.get(key);
    if (!ctx || !info || !load || !this.gain || session !== this.session) return;
    const buffer = load.chunks[index];
    if (!buffer) return;

    let when = info.startAt + load.offsets[index];
    const earliest = ctx.currentTime + START_EPSILON;
    if (when < earliest) {
      info.startAt += earliest - when;
      when = earliest;
    }
    this.startChunkSource(key, index, buffer, when, 0, session);
  }

  private startChunkSource(key: number, index: number, buffer: AudioBuffer, when: number, offset: number, session: number) {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(when, offset);
    let nodes = this.sources.get(key);
    if (!nodes) {
      nodes = new Map();
      this.sources.set(key, nodes);
    }
    nodes.set(index, source);
    source.onended = () => this.handleChunkEnded(key, index, session);
  }

  // A cold start creates or resumes the AudioContext, and the OS audio
  // device behind it takes a moment to come up — during which
  // currentTime is not a clock anything can be placed against. Hold every
  // anchor until resume() resolves (the device is running), then chain
  // whatever has arrived meanwhile. Runs alongside the network fetch, so
  // on the LAN it costs nothing. The timeout is a backstop for an engine
  // whose resume() never settles (autoplay policy): better to try than to
  // sit at "loading" forever.
  private awaitClock(ctx: AudioContext, session: number) {
    // A restart while something is audibly playing (Next, Previous, a
    // queue edit on the current entry) is on a clock that is already
    // proven live — no wait, so the skip is seamless.
    const mid = this.status === "playing" || this.status === "loading";
    if (this.clockRunning && ctx.state === "running" && mid) return;
    this.clockRunning = false;
    const ready = () => {
      if (session !== this.session || this.clockRunning) return;
      this.clockRunning = true;
      if (this.currentKey != null) this.maybeChain(this.currentKey, session);
    };
    let resumed: Promise<void>;
    try {
      resumed = Promise.resolve(ctx.resume());
    } catch {
      resumed = Promise.resolve();
    }
    resumed.then(ready, ready);
    setTimeout(ready, CLOCK_READY_TIMEOUT_MS);
  }

  // Lay down `key`'s anchor at `startAt` and schedule every chunk received
  // so far; later chunks schedule themselves as they land (onChunk).
  private anchor(key: number, startAt: number, session: number) {
    const load = this.loads.get(key);
    const entry = this.entry(key);
    if (!load || !entry || session !== this.session || !this.clockRunning) return;

    this.schedule.set(key, {
      startAt,
      duration: load.complete ? load.totalSecs : (entry.durationSecs ?? 0),
      complete: load.complete,
    });
    for (let i = 0; i < load.chunks.length; i++) this.scheduleChunk(key, i, session);

    if (key === this.currentKey) {
      this.duration = load.complete ? load.totalSecs : (entry.durationSecs ?? null);
      // A pause that landed while this entry was still loading suspended
      // the context; leave the status alone so play() is what resumes it.
      if (this.status !== "paused") this.status = "playing";
      // A real track is now audibly scheduled — any earlier load-failure
      // banner (this one or an already-skipped one) no longer applies, and
      // its own download indicator is done with.
      this.lastError = null;
      this.loadProgress = null;
      this.emit();
      // Only the currently-playing entry pulls in its successor, and only
      // once its own stream is done (see the pacing note in the header
      // comment; onLoadComplete handles the still-streaming case).
      if (load.complete) this.pullSuccessor(key, session);
    }
  }

  private prefetch(key: number | null) {
    if (key == null) return;
    const entry = this.entry(key);
    if (!entry) return;
    if (this.loads.has(key)) return;
    const ctx = this.ctx;
    if (!ctx) return;

    const load: TrackLoad = {
      chunks: [],
      offsets: [],
      totalSecs: 0,
      complete: false,
      lastEndedIndex: -1,
      abort: new AbortController(),
    };
    this.loads.set(key, load);
    // Only the current entry's download is worth showing — a background
    // prefetch of the next track happens while its predecessor is already
    // audibly playing, so there's nothing for a progress indicator to
    // usefully tell the user there.
    if (key === this.currentKey) this.loadProgress = null;
    const handlers: TrackStreamHandlers = {
      onChunk: (buffer) => this.onChunk(key, load, buffer),
      onProgress: (p) => {
        if (!this.isLiveLoad(key, load) || key !== this.currentKey || this.schedule.has(key)) return;
        this.loadProgress = p;
        this.emit();
      },
    };
    this.deps
      .loadTrack(ctx, entry.trackId, handlers, load.abort.signal)
      .then(() => this.onLoadComplete(key, load))
      .catch((err) => this.onLoadFailed(key, load, err));
  }

  private onChunk(key: number, load: TrackLoad, buffer: AudioBuffer) {
    if (!this.isLiveLoad(key, load)) return;
    if (!this.wanted(key)) {
      load.abort.abort();
      this.loads.delete(key);
      return;
    }
    const index = load.chunks.length;
    load.chunks.push(buffer);
    load.offsets.push(load.totalSecs);
    load.totalSecs += buffer.duration;
    if (this.schedule.has(key)) this.scheduleChunk(key, index, this.session);
    else this.maybeChain(key, this.session);
  }

  private onLoadComplete(key: number, load: TrackLoad) {
    if (!this.isLiveLoad(key, load)) return;
    load.complete = true;
    const info = this.schedule.get(key);
    if (info) {
      info.duration = load.totalSecs;
      info.complete = true;
      if (key === this.currentKey) {
        this.duration = load.totalSecs;
        this.loadProgress = null;
        this.emit();
      }
    } else {
      // Nothing scheduled yet — either no chunk has landed (an empty
      // stream, treated as a zero-length track) or the predecessor's end
      // isn't known yet. maybeChain sorts out which.
      this.maybeChain(key, this.session);
    }
    // Now that this entry's end time is known, a successor whose chunks
    // have been waiting can chain on — and the current entry, its own
    // stream done, is what pulls the successor in to begin with.
    if (key === this.currentKey) this.pullSuccessor(key, this.session);
    else {
      const next = this.nextKey(key);
      if (next != null && this.loads.has(next)) this.maybeChain(next, this.session);
    }
    // The final chunk may already have finished playing (a stall right at
    // the end of a track): its onended couldn't know it was the last.
    if (load.chunks.length > 0 && load.lastEndedIndex === load.chunks.length - 1) {
      this.sources.delete(key);
      this.advanceFrom(key, this.session);
    }
  }

  private onLoadFailed(key: number, load: TrackLoad, err: unknown) {
    if (!this.isLiveLoad(key, load)) return;
    if (load.abort.signal.aborted) return; // our own doing — not a failure
    const entry = this.entry(key);
    const ctx = this.ctx;
    console.warn(`[player] "${entry?.title ?? key}" failed to load:`, err);
    if (!entry || !ctx) return;
    // Visible, not just console.warn'd — a fetch/decode failure here
    // otherwise looks identical to normal playback (status stays
    // whatever it was, the chain just silently skips ahead), which is
    // exactly what made an off-LAN network failure indistinguishable
    // from "plays but no sound" without a laptop tethered to inspect
    // the console.
    this.lastError = { title: entry.title, message: err instanceof Error ? err.message : String(err) };
    this.loadProgress = null;

    if (this.schedule.has(key) && load.chunks.length > 0) {
      // Died part-way through a track that's already playing: what
      // arrived is all there is, so it ends early rather than stalling.
      this.onLoadComplete(key, load);
      return;
    }

    // Leave a zero-duration passthrough anchor so the chain can still
    // advance past this broken entry instead of stalling forever.
    this.loads.delete(key);
    const prevKey = this.prevKey(key) ?? NO_PREDECESSOR;
    const prev = this.schedule.get(prevKey);
    this.schedule.set(key, {
      startAt: prev && prev.complete ? prev.startAt + prev.duration : ctx.currentTime + START_EPSILON,
      duration: 0,
      complete: true,
    });
    if (key === this.currentKey) {
      // The current entry itself is unplayable: move on immediately
      // rather than waiting for an onended that will never fire.
      this.advanceFrom(key, this.session);
      return;
    }
    this.emit();
    this.prefetch(this.nextKey(key));
  }

  // Chain `key` onto its predecessor's anchor (per play order), if the
  // predecessor's end is known, this key hasn't been anchored yet, and at
  // least one chunk (or the whole, empty, stream) has arrived to anchor.
  // By construction (every anchor / seed writes schedule[prev] before
  // prefetching its successor), the predecessor entry is always present
  // by the time this can matter.
  private maybeChain(key: number, session: number) {
    if (this.schedule.has(key)) return;
    const load = this.loads.get(key);
    if (!load || (load.chunks.length === 0 && !load.complete)) return;
    const prevKey = this.prevKey(key) ?? NO_PREDECESSOR;
    const prev = this.schedule.get(prevKey);
    if (!prev || !prev.complete) return;
    if (load.chunks.length === 0) {
      // Completed with no audio at all — a zero-length pass-through.
      this.schedule.set(key, { startAt: prev.startAt + prev.duration, duration: 0, complete: true });
      if (key === this.currentKey) this.advanceFrom(key, session);
      return;
    }
    this.anchor(key, prev.startAt + prev.duration, session);
  }

  private handleChunkEnded(key: number, index: number, session: number) {
    if (session !== this.session) return;
    this.sources.get(key)?.delete(index);
    const load = this.loads.get(key);
    if (!load) return;
    load.lastEndedIndex = Math.max(load.lastEndedIndex, index);
    if (load.complete && index === load.chunks.length - 1) {
      this.sources.delete(key);
      this.advanceFrom(key, session);
    }
  }

  /** Playback has passed `key`: make its successor current (or wrap /
   *  finish). Shared by the natural end-of-track path and the failed-load
   *  path. */
  private advanceFrom(key: number, session: number) {
    const next = this.nextKey(key);
    if (next == null) {
      if (this.repeat && this.order.length > 0) {
        this.startFrom(this.order[0]);
        return;
      }
      this.onQueueEnded();
      return;
    }

    const entry = this.entry(next);
    this.currentKey = next;
    this.dropUnwantedLoads();
    // The normal case (a real end of track) always finds `next` already
    // streaming or streamed — anchor()'s / onLoadComplete's own
    // prefetch-the-successor call saw to that — so this is a no-op there.
    // But advanceFrom is also called directly from a failed *current*
    // track's load (see onLoadFailed), where `next` was never requested
    // by anyone: without this, currentKey moves on but nothing ever
    // fetches its audio, leaving status stuck at "loading" — which the
    // player bars render identically to "playing" — forever silent.
    this.prefetch(next);
    // Playback reached `next` — now, and only now, pull in the entry after
    // it (once next's own stream is done; onLoadComplete covers the case
    // where it's still arriving).
    if (this.loads.get(next)?.complete) this.pullSuccessor(next, session);

    const info = this.schedule.get(next);
    if (info) {
      this.duration = info.complete ? info.duration : (entry?.durationSecs ?? null);
      this.status = "playing";
      // Only a *real* scheduled source (hasLiveSource) means `next`
      // actually has audio playing — a zero-duration passthrough anchor
      // (see onLoadFailed) also leaves `info` set but for a track that
      // itself failed, so it must not clear the banner that failure just
      // raised.
      if (this.hasLiveSource(next)) {
        this.lastError = null;
        this.loadProgress = null;
      }
    } else {
      // Nothing of `next` has landed yet — anchor() will flip this back to
      // "playing" (and set the duration) once its first chunk does.
      this.duration = entry?.durationSecs ?? null;
      this.status = "loading";
    }
    this.emit();
  }

  private onQueueEnded() {
    this.session++; // invalidate any straggling source callbacks
    this.stopAllSources();
    this.schedule.clear();
    this.dropLoadsExcept(null);
    const restartKey = this.order[0] ?? null;
    this.currentKey = restartKey;
    this.status = "idle";
    this.duration = restartKey == null ? null : (this.entry(restartKey)?.durationSecs ?? null);
    this.emit();
  }

  // Reset the graph and begin playback at `key` — used for the initial
  // Play, for Next/Previous/jumpTo, and for looping back to the top on
  // repeat. Seeds a zero-duration anchor at key's predecessor (per play
  // order) so maybeChain's normal chaining logic can bootstrap a fresh
  // start exactly like it recovers from a failed entry.
  private startFrom(key: number) {
    const entry = this.entry(key);
    if (!entry) return;
    const ctx = this.ensureContext();

    const session = ++this.session;
    this.awaitClock(ctx, session);
    this.stopAllSources();
    this.schedule.clear();
    // Keep `key`'s own load if prefetch pacing already started (or
    // finished) it — the common case: Next after its target was pulled in
    // ahead of time while its predecessor played. Its chunks are immutable
    // audio, independent of the timing state being reset here, and a
    // still-streaming load keeps delivering under the new session —
    // discarding either would just mean downloading the same bytes twice.
    // Its successor's load (Previous back onto a track whose follower is
    // what was just playing) is kept for the same reason.
    this.currentKey = key;
    this.dropUnwantedLoads();

    this.status = "loading";
    this.duration = entry.durationSecs ?? null;

    const seedKey = this.prevKey(key) ?? NO_PREDECESSOR;
    this.schedule.set(seedKey, { startAt: ctx.currentTime + START_EPSILON, duration: 0, complete: true });
    this.emit();
    if (this.loads.has(key)) this.maybeChain(key, session);
    else this.prefetch(key);
  }

  /** After any edit to the play order beyond the current entry: drop every
   *  scheduled successor (it may no longer be next) and pull in whatever is
   *  next now. keepLoads spares the successor's audio if it happens to
   *  still be next — right for edits that can't change what's next
   *  (append, seek), a wasted re-fetch otherwise. */
  private rechainAfterCurrent(opts: { keepLoads: boolean }) {
    const current = this.currentKey;
    for (const key of [...this.sources.keys()]) {
      if (key !== current) this.stopSource(key);
    }
    const currentAnchor = current == null ? undefined : this.schedule.get(current);
    this.schedule.clear();
    if (current != null) {
      if (currentAnchor) {
        this.schedule.set(current, currentAnchor);
      } else if (this.ctx) {
        // Still loading: re-seed under whatever its predecessor is now, so
        // maybeChain can find the anchor when the first chunk lands.
        this.schedule.set(this.prevKey(current) ?? NO_PREDECESSOR, {
          startAt: this.ctx.currentTime + START_EPSILON,
          duration: 0,
          complete: true,
        });
      }
    }
    if (!opts.keepLoads) this.dropLoadsExcept(current);

    if (this.status === "idle" || current == null) return;
    // Pacing: the successor is only *requested* once the current entry's
    // own stream is complete (onLoadComplete does it otherwise) — but one
    // that is already here can chain straight away.
    const next = this.nextKey(current);
    if (next != null && this.loads.has(next)) this.maybeChain(next, this.session);
    else if (this.loads.get(current)?.complete) this.pullSuccessor(current, this.session);
  }

  // ---------------------------------------------------------------------
  // Public: building the queue
  // ---------------------------------------------------------------------

  /** Replace the queue and start playing. `startIndex` is into `tracks`;
   *  with `shuffle` the chosen track still plays first, the rest shuffled
   *  behind it (no startIndex + shuffle = everything shuffled). */
  playTracks(
    tracks: QueueTrack[],
    opts: { startIndex?: number; shuffle?: boolean; context?: PlaybackContext } = {},
  ) {
    if (tracks.length === 0) {
      this.clearQueue();
      return;
    }
    const entries = this.makeEntries(tracks);
    const keys = entries.map((e) => e.key);
    const startIndex = Math.min(Math.max(opts.startIndex ?? 0, 0), entries.length - 1);
    const startKey = keys[startIndex];

    this.queue = entries;
    this.shuffle = opts.shuffle ?? this.shuffle;
    if (this.shuffle) {
      this.order =
        opts.startIndex == null ? shuffled(keys) : [startKey, ...shuffled(keys.filter((k) => k !== startKey))];
    } else {
      this.order = keys;
    }
    this.context = opts.context ?? { kind: "queue" };
    this.startFrom(opts.startIndex == null && this.shuffle ? this.order[0] : startKey);
  }

  /** Insert right after the current entry. With nothing queued this is
   *  just Play (`context` only matters in that case — it labels what the
   *  queue was built from). */
  playNext(tracks: QueueTrack[], context?: PlaybackContext) {
    if (tracks.length === 0) return;
    if (this.currentKey == null || this.queue.length === 0) {
      this.playTracks(tracks, { context });
      return;
    }
    const entries = this.makeEntries(tracks);
    const keys = entries.map((e) => e.key);
    const queueAt = this.queue.findIndex((e) => e.key === this.currentKey) + 1;
    const orderAt = this.orderIndex(this.currentKey) + 1;
    this.queue = [...this.queue.slice(0, queueAt), ...entries, ...this.queue.slice(queueAt)];
    this.order = [...this.order.slice(0, orderAt), ...keys, ...this.order.slice(orderAt)];
    this.rechainAfterCurrent({ keepLoads: false });
    this.emit();
  }

  /** Append to the end of the queue. With nothing queued this is just Play. */
  addToQueue(tracks: QueueTrack[], context?: PlaybackContext) {
    if (tracks.length === 0) return;
    if (this.currentKey == null || this.queue.length === 0) {
      this.playTracks(tracks, { context });
      return;
    }
    const entries = this.makeEntries(tracks);
    this.queue = [...this.queue, ...entries];
    this.order = [...this.order, ...entries.map((e) => e.key)];
    // Nothing beyond the current entry could have been scheduled unless it
    // already had a successor — in which case that successor is unchanged.
    this.rechainAfterCurrent({ keepLoads: true });
    this.emit();
  }

  removeFromQueue(key: number) {
    if (!this.entry(key)) return;
    const wasCurrent = key === this.currentKey;
    const wasNext = key === this.nextKey(this.currentKey);
    const successor = wasCurrent ? this.nextKey(key) : null;

    this.queue = this.queue.filter((e) => e.key !== key);
    this.order = this.order.filter((k) => k !== key);

    if (this.queue.length === 0) {
      this.clearQueue();
      return;
    }
    if (wasCurrent) {
      if (successor != null && this.status !== "idle") {
        this.startFrom(successor);
        return;
      }
      this.stopSource(key);
      this.loads.get(key)?.abort.abort();
      this.loads.delete(key);
      this.schedule.delete(key);
      this.currentKey = successor ?? this.order[0] ?? null;
      if (this.status !== "idle") this.onQueueEnded();
      else {
        this.duration = this.currentKey == null ? null : (this.entry(this.currentKey)?.durationSecs ?? null);
        this.emit();
      }
      return;
    }
    if (wasNext) {
      this.stopSource(key);
      this.loads.get(key)?.abort.abort();
      this.loads.delete(key);
      this.rechainAfterCurrent({ keepLoads: false });
    }
    this.emit();
  }

  /** Move an entry to `toOrderIndex` in play order. With shuffle off the
   *  insertion order is the play order, so it moves there too (which is
   *  what un-shuffling later restores). */
  moveInQueue(key: number, toOrderIndex: number) {
    const from = this.orderIndex(key);
    if (from === -1) return;
    const to = Math.min(Math.max(toOrderIndex, 0), this.order.length - 1);
    if (from === to) return;
    const order = [...this.order];
    order.splice(from, 1);
    order.splice(to, 0, key);
    this.order = order;
    if (!this.shuffle) {
      const byKey = new Map(this.queue.map((e) => [e.key, e]));
      this.queue = order.map((k) => byKey.get(k)!);
    }
    this.rechainAfterCurrent({ keepLoads: false });
    this.emit();
  }

  clearQueue() {
    this.session++;
    this.stopAllSources();
    this.schedule.clear();
    this.dropLoadsExcept(null);
    this.queue = [];
    this.order = [];
    this.currentKey = null;
    this.status = "idle";
    this.duration = null;
    this.context = null;
    this.emit();
  }

  /** Start playing a specific queue entry now. */
  jumpTo(key: number) {
    if (!this.entry(key)) return;
    this.startFrom(key);
  }

  // ---------------------------------------------------------------------
  // Public: transport
  // ---------------------------------------------------------------------

  play() {
    if (this.status === "playing" || this.status === "loading") return;
    if (this.status === "paused" && this.ctx) {
      // Also covers Safari's "interrupted" state (a phone call, another
      // app taking the output) — resume() is the way back from both.
      this.ctx.resume();
      this.status = "playing";
      this.emit();
      return;
    }
    const key = this.currentKey ?? this.order[0];
    if (key != null) this.startFrom(key);
  }

  pause() {
    if (this.status !== "playing" && this.status !== "loading") return;
    this.ctx?.suspend();
    this.status = "paused";
    this.emit();
  }

  toggle() {
    if (this.status === "playing" || this.status === "loading") this.pause();
    else this.play();
  }

  next() {
    if (this.status === "idle" || this.currentKey == null) return;
    const target = this.nextKey(this.currentKey);
    if (target == null) {
      if (this.repeat && this.order.length > 0) this.startFrom(this.order[0]);
      return;
    }
    this.startFrom(target);
  }

  previous() {
    if (this.status === "idle" || this.currentKey == null) return;
    const pos = this.getPosition();
    const target = pos && pos.elapsed > PREVIOUS_RESTART_SECS ? null : this.prevKey(this.currentKey);
    this.startFrom(target ?? this.currentKey);
  }

  /** Jump within the current entry. Needs some of its audio to have
   *  arrived (i.e. not while "loading"), and is clamped to what has —
   *  on the LAN the whole track lands within about a second, so that's
   *  only ever a limit on a slow link. Zero network cost: new source
   *  nodes on the same chunks, the anchor shifted back by `secs` so
   *  getPosition() and the successor's chain arithmetic are untouched. */
  seek(secs: number) {
    const key = this.currentKey;
    const ctx = this.ctx;
    if (key == null || !ctx || !this.gain) return;
    const load = this.loads.get(key);
    const info = this.schedule.get(key);
    if (!load || !info || load.chunks.length === 0) return;
    const maxSeek = load.complete ? Math.max(load.totalSecs - 0.05, 0) : load.totalSecs;
    const target = Math.min(Math.max(secs, 0), maxSeek);
    const session = this.session;

    this.stopSource(key);
    const now = ctx.currentTime + START_EPSILON;
    info.startAt = now - target;
    for (let i = 0; i < load.chunks.length; i++) {
      const offset = load.offsets[i];
      const buffer = load.chunks[i];
      if (offset + buffer.duration <= target) continue; // already behind the seek point
      const into = Math.max(target - offset, 0);
      this.startChunkSource(key, i, buffer, Math.max(info.startAt + offset, now), into, session);
    }

    this.rechainAfterCurrent({ keepLoads: true });
    this.emit();
  }

  /** Reshuffles everything AFTER the current entry, leaving it in place —
   *  turning shuffle on/off never interrupts what's already playing.
   *  Turning it off restores insertion order. */
  setShuffle(on: boolean) {
    if (on === this.shuffle) return;
    this.shuffle = on;
    const keys = this.queue.map((e) => e.key);
    if (on) {
      const current = this.currentKey;
      const rest = keys.filter((k) => k !== current);
      this.order = current == null ? shuffled(rest) : [current, ...shuffled(rest)];
    } else {
      this.order = keys;
    }
    this.rechainAfterCurrent({ keepLoads: false });
    this.emit();
  }

  setRepeat(on: boolean) {
    if (on === this.repeat) return;
    this.repeat = on;
    this.emit();
  }

  setVolume(v: number) {
    const clamped = Math.min(Math.max(v, 0), 1);
    this.volume = clamped;
    if (this.gain) this.gain.gain.value = clamped;
    this.emit();
  }

  /** Where the current entry is, for the UI's rAF-driven progress bar —
   *  read on demand so a ~60fps readout never re-renders anything. */
  getPosition(): { elapsed: number; duration: number } | null {
    if (this.currentKey == null) return null;
    const info = this.schedule.get(this.currentKey);
    const duration = info && info.duration > 0 ? info.duration : (this.duration ?? 0);
    if (this.ctx && info && duration > 0) {
      const elapsed = Math.min(Math.max(this.ctx.currentTime - info.startAt, 0), duration);
      return { elapsed, duration };
    }
    return { elapsed: 0, duration };
  }
}

/** The one engine per page. Kept on globalThis so a Fast Refresh remount
 *  of the provider (or any accidental remount of the shell) can never
 *  create a second AudioContext or stop what's playing. Client-only. */
export function getPlayerEngine(): PlayerEngine {
  const g = globalThis as unknown as { __mediaVaultPlayer?: PlayerEngine };
  if (!g.__mediaVaultPlayer) g.__mediaVaultPlayer = new PlayerEngine();
  return g.__mediaVaultPlayer;
}
