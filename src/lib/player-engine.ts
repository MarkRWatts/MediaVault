// The app-wide gapless music engine. Web Audio API, not <audio>/MSE — a
// plain <audio> element re-buffers and re-decodes at every track boundary
// (an audible gap even for back-to-back files), where scheduling
// pre-decoded AudioBufferSourceNodes at exact sample-accurate AudioContext
// times gives a true gapless join. See PLAN.md "Playback" for why this
// exists and src/lib/audio-stream.ts for what /api/audio/<id> actually
// serves (original bytes for mp3/aac, a lossless FLAC remux for alac/flac).
//
// This used to live inside the album page's AlbumPlayer component, one
// engine per page visit. It is now a single instance for the life of the
// page (components/player/PlayerProvider.tsx owns it), fed a queue of
// arbitrary tracks — several albums, a playlist, favourites — so playback
// survives client-side navigation. Framework-free on purpose: the two
// browser touch-points (AudioContext construction, fetch+decode) are
// injected through EngineDeps, which is what lets player-engine.test.ts
// drive it with a fake clock and no network.
//
// Queue model: `queue` is every entry in insertion order (the natural
// order shuffle restores); `order` is the entry keys in play order; every
// internal map (decoded buffers, live source nodes, schedule anchors,
// in-flight fetches) is keyed by QueueEntry.key — an engine-assigned id
// unique per enqueue. Positions shift on every edit and one track can sit
// in the queue twice, so neither is a usable key.
//
// Scheduling model: every entry's playback is described by an anchor
// { startAt, duration } in `schedule`. startAt is an absolute
// AudioContext.currentTime coordinate, duration is the *decoded* buffer's
// real duration (not the DB's durationSecs estimate, which is what makes
// the join sample-accurate). prefetch(), once its fetch+decode resolves,
// chains itself onto whatever anchor its immediate predecessor (per play
// order) left behind — that chaining is the gapless engine. A track that
// fails to load leaves a zero-duration passthrough anchor instead of a
// real one, so the chain still advances past it (console.warn'd) rather
// than stalling.
//
// Prefetch pacing is driven by PLAYBACK, not by decode completion:
// scheduleAt(key) only kicks off prefetch of key's successor when key is
// the entry playing right now, and handleTrackEnded triggers the next
// prefetch as playback advances. Without that gate the
// schedule→decode→schedule cascade races through the whole queue in
// seconds, holding every decoded AudioBuffer at once (~1.5 GB of PCM for
// a 20-track album). With it, at most two decoded buffers are alive
// (current + next), and `buffers` is pruned down to just the current entry
// as soon as playback advances past a track. Queue edits (play next, add,
// remove, move, reshuffle) all funnel through rechainAfterCurrent(), which
// tears down everything scheduled beyond the current entry and re-pulls
// the new successor — so the invariant holds however the queue is
// rearranged mid-play, and a fetch that resolves for an entry that is no
// longer current-or-next is simply dropped (see wanted()).

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

export interface EngineDeps {
  /** Construct the one AudioContext. Only ever called from a user gesture
   *  (Play) — autoplay policy requires it. */
  createContext: () => AudioContext;
  /** Fetch + decode one track. The default hits /api/audio/<id> (FLAC, or a
   *  small lossy remux off-LAN) and retries as WAV for engines whose
   *  decodeAudioData rejects FLAC. onProgress, if given, is called
   *  repeatedly while the fetch is in flight. */
  loadBuffer: (ctx: AudioContext, trackId: number, onProgress?: (p: PlayerLoadProgress) => void) => Promise<AudioBuffer>;
}

interface ScheduleInfo {
  startAt: number;
  duration: number;
}

// Lead-in for a scheduled start — starting exactly at ctx.currentTime can
// race the audio hardware clock on some browsers and clip the first few
// samples.
const START_EPSILON = 0.05;

// Sentinel key for "no predecessor" anchors in `schedule` — real entry
// keys start at 1, so -1 never collides with one.
const NO_PREDECESSOR = -1;

// "Previous" restarts the current track once it's this far in, and only
// steps back to the previous entry before that — the convention every
// player follows.
const PREVIOUS_RESTART_SECS = 3;

// One retry on a 503 from /api/audio (every ffmpeg remux slot taken — see
// AUDIO_BUSY in src/lib/audio-stream.ts) before giving up on a format.
const MAX_RETRY_AFTER_MS = 15_000;

// decodeAudioData has a promise-returning form (every current browser
// engine) and an older callback form (pre-2021 Safari); support both.
function decodeAudioData(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(data, resolve, reject) as unknown;
    if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === "function") {
      (maybePromise as Promise<AudioBuffer>).then(resolve, reject);
    }
  });
}

// Reads the response body incrementally (rather than the simpler
// res.arrayBuffer()) purely to report progress as it downloads — without
// this, a large lossless file on a slow connection looks identical, byte
// for byte, to a hung request until the whole thing lands. See the header
// comment on why decodeAudioData still needs the complete buffer either
// way: this doesn't make playback start any sooner, only tells the UI
// something real is happening instead of nothing.
async function readBytesWithProgress(res: Response, onProgress?: (p: PlayerLoadProgress) => void): Promise<ArrayBuffer> {
  if (!res.body || !onProgress) return res.arrayBuffer();

  const totalHeader = res.headers.get("Content-Length");
  const total = totalHeader != null && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

async function fetchAudioBytes(url: string, onProgress?: (p: PlayerLoadProgress) => void): Promise<ArrayBuffer> {
  let res = await fetch(url);
  if (res.status === 503) {
    const secs = Number(res.headers.get("Retry-After"));
    const ms = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : 2000;
    await new Promise((r) => setTimeout(r, ms));
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readBytesWithProgress(res, onProgress);
}

/** The production loadBuffer: a small lossy remux off-LAN or FLAC on it
 *  (smaller over the wire either way, see audio-stream.ts); if THIS engine
 *  can't decode what it got (Safari's decodeAudioData rejects FLAC, with a
 *  null error no less), retry once as lossless WAV before giving up. */
export function fetchAndDecode(
  ctx: AudioContext,
  trackId: number,
  onProgress?: (p: PlayerLoadProgress) => void,
): Promise<AudioBuffer> {
  const loadAndDecode = (url: string) => fetchAudioBytes(url, onProgress).then((data) => decodeAudioData(ctx, data));
  return loadAndDecode(`/api/audio/${trackId}`).catch(() => loadAndDecode(`/api/audio/${trackId}?fmt=wav`));
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

  private readonly buffers = new Map<number, AudioBuffer>();
  private readonly sources = new Map<number, AudioBufferSourceNode>();
  private readonly schedule = new Map<number, ScheduleInfo>();
  private readonly pending = new Set<number>();
  /** Bumped on every hard restart; a prefetch that resolves for an older
   *  session is discarded. */
  private session = 0;
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
      loadBuffer: deps.loadBuffer ?? fetchAndDecode,
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

  /** Is a decoded buffer for `key` still worth keeping? Only the current
   *  entry and its successor ever are — anything else is a fetch that was
   *  overtaken by a queue edit. */
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
    const source = this.sources.get(key);
    if (!source) return;
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
    this.sources.delete(key);
  }

  private stopAllSources() {
    for (const key of [...this.sources.keys()]) this.stopSource(key);
  }

  private releaseBuffersExcept(keepKey: number) {
    for (const key of [...this.buffers.keys()]) {
      if (key !== keepKey) this.buffers.delete(key);
    }
  }

  private scheduleAt(key: number, startAt: number, session: number) {
    const ctx = this.ctx;
    const buffer = this.buffers.get(key);
    if (!ctx || !buffer || !this.gain || session !== this.session) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    // A `when` in the past is clamped to "now" by the Web Audio spec — the
    // relevant case here is a slow prefetch chaining onto an anchor that
    // has already elapsed, which just starts immediately instead of erroring.
    source.start(Math.max(startAt, ctx.currentTime));
    this.sources.set(key, source);
    this.schedule.set(key, { startAt, duration: buffer.duration });

    source.onended = () => this.handleTrackEnded(key, session);

    if (key === this.currentKey) {
      this.duration = buffer.duration;
      // A pause that landed while this entry was still loading suspended
      // the context; leave the status alone so play() is what resumes it.
      if (this.status !== "paused") this.status = "playing";
      // A real track is now audibly scheduled — any earlier load-failure
      // banner (this one or an already-skipped one) no longer applies, and
      // its own download (if this is the entry that was just downloading)
      // is done.
      this.lastError = null;
      this.loadProgress = null;
      this.emit();
    }

    // Only the currently-playing entry pulls in its successor — an entry
    // scheduled for the future must NOT (see the pacing note in the header
    // comment; handleTrackEnded advances the chain when playback reaches it).
    if (this.currentKey != null && this.orderIndex(key) <= this.orderIndex(this.currentKey)) {
      const next = this.nextKey(key);
      if (next != null) this.prefetch(next, session);
    }
  }

  private prefetch(key: number | null, session: number) {
    if (key == null) return;
    const entry = this.entry(key);
    if (!entry) return;
    if (this.buffers.has(key) || this.pending.has(key)) return;
    const ctx = this.ctx;
    if (!ctx) return;

    this.pending.add(key);
    // Only the current entry's download is worth showing — a background
    // prefetch of the next track happens while its predecessor is already
    // audibly playing, so there's nothing for a progress indicator to
    // usefully tell the user there.
    if (key === this.currentKey) this.loadProgress = null;
    const onProgress =
      key === this.currentKey
        ? (p: PlayerLoadProgress) => {
            if (session !== this.session || key !== this.currentKey) return;
            this.loadProgress = p;
            this.emit();
          }
        : undefined;
    this.deps
      .loadBuffer(ctx, entry.trackId, onProgress)
      .then((buffer) => {
        this.pending.delete(key);
        if (session !== this.session || !this.wanted(key)) return;
        this.buffers.set(key, buffer);
        this.maybeChain(key, session);
      })
      .catch((err) => {
        this.pending.delete(key);
        console.warn(`[player] skipping "${entry.title}" — failed to load:`, err);
        if (session !== this.session || !this.wanted(key)) return;
        // Visible, not just console.warn'd — a fetch/decode failure here
        // otherwise looks identical to normal playback (status stays
        // whatever it was, the chain just silently skips ahead), which is
        // exactly what made an off-LAN network failure indistinguishable
        // from "plays but no sound" without a laptop tethered to inspect
        // the console.
        this.lastError = { title: entry.title, message: err instanceof Error ? err.message : String(err) };
        this.loadProgress = null;
        // Leave a zero-duration passthrough anchor so the chain can still
        // advance past this broken entry instead of stalling forever.
        const prevKey = this.prevKey(key) ?? NO_PREDECESSOR;
        const prev = this.schedule.get(prevKey) ?? {
          startAt: ctx.currentTime + START_EPSILON,
          duration: 0,
        };
        this.schedule.set(key, prev);
        if (key === this.currentKey) {
          // The current entry itself is unplayable: move on immediately
          // rather than waiting for an onended that will never fire.
          this.advanceFrom(key, session);
          return;
        }
        this.emit();
        this.prefetch(this.nextKey(key), session);
      });
  }

  // Chain a freshly-decoded buffer onto its predecessor's anchor (per play
  // order), if the predecessor has already been (or was just) scheduled and
  // this key hasn't been claimed yet. By construction (every scheduleAt /
  // seed writes schedule[key] before calling prefetch(next)), the
  // predecessor entry is always present by the time this runs.
  private maybeChain(key: number, session: number) {
    if (this.schedule.has(key)) return;
    const prevKey = this.prevKey(key) ?? NO_PREDECESSOR;
    const prev = this.schedule.get(prevKey);
    if (!prev) return;
    this.scheduleAt(key, prev.startAt + prev.duration, session);
  }

  private handleTrackEnded(key: number, session: number) {
    if (session !== this.session) return;
    this.sources.delete(key);
    this.advanceFrom(key, session);
  }

  /** Playback has passed `key`: make its successor current (or wrap /
   *  finish). Shared by the natural onended path and the failed-load path. */
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
    this.releaseBuffersExcept(next);
    // The normal case (a real onended) always finds `next` already
    // fetched — scheduleAt's own prefetch-the-successor call saw to that
    // — so this is a no-op there. But advanceFrom is also called directly
    // from a failed *current* track's load (see prefetch()'s catch),
    // where `next` was never requested by anyone: without this, currentKey
    // moves on but nothing ever fetches its buffer, leaving status stuck
    // at "loading" — which the player bars render identically to
    // "playing" — forever silent.
    this.prefetch(next, session);
    // Playback reached `next` (already scheduled & decoded, in the normal
    // case) — now, and only now, pull in the entry after it.
    this.prefetch(this.nextKey(next), session);

    const info = this.schedule.get(next);
    if (info) {
      this.duration = info.duration;
      this.status = "playing";
      // Only a *real* scheduled source (this.sources.has) means `next`
      // actually decoded and is audibly playing — a zero-duration
      // passthrough anchor (see prefetch()'s catch) also leaves `info` set
      // but for a track that itself failed, so it must not clear the
      // banner that failure just raised.
      if (this.sources.has(next)) {
        this.lastError = null;
        this.loadProgress = null;
      }
    } else {
      // Prefetch for `next` hasn't resolved yet — scheduleAt will flip this
      // back to "playing" (and set the real duration) once it does.
      this.duration = entry?.durationSecs ?? null;
      this.status = "loading";
    }
    this.emit();
  }

  private onQueueEnded() {
    this.session++; // invalidate any straggling prefetches
    this.stopAllSources();
    this.schedule.clear();
    this.buffers.clear();
    this.pending.clear();
    const restartKey = this.order[0] ?? null;
    this.currentKey = restartKey;
    this.status = "idle";
    this.duration = restartKey == null ? null : (this.entry(restartKey)?.durationSecs ?? null);
    this.emit();
  }

  // Reset the graph and begin playback at `key` — used for the initial
  // Play, for Next/Previous/jumpTo, and for looping back to the top on
  // repeat. Seeds a zero-duration anchor at key's predecessor (per play
  // order) so prefetch/maybeChain's normal chaining logic can bootstrap a
  // fresh start exactly like it recovers from a failed entry.
  private startFrom(key: number) {
    const entry = this.entry(key);
    if (!entry) return;
    const ctx = this.ensureContext();
    if (ctx.state !== "running") ctx.resume();

    const session = ++this.session;
    this.stopAllSources();
    this.schedule.clear();
    // Keep `key`'s buffer if prefetch pacing already decoded it (the
    // common case: Next after its target was pulled in ahead of time
    // while its predecessor played) — a decoded AudioBuffer is immutable
    // audio content, independent of the session/timing state being reset
    // here, so discarding it just means downloading the exact bytes
    // sitting in memory all over again.
    const hadBuffer = this.buffers.has(key);
    this.releaseBuffersExcept(key);
    this.pending.clear();

    this.currentKey = key;
    this.status = "loading";
    this.duration = entry.durationSecs ?? null;

    const seedKey = this.prevKey(key) ?? NO_PREDECESSOR;
    this.schedule.set(seedKey, { startAt: ctx.currentTime + START_EPSILON, duration: 0 });
    this.emit();
    // prefetch() no-ops when a buffer's already present (see its own
    // buffers.has guard) — chain it onto the seed anchor directly instead,
    // the same call its own success handler would have made.
    if (hadBuffer) this.maybeChain(key, session);
    else this.prefetch(key, session);
  }

  /** After any edit to the play order beyond the current entry: drop every
   *  scheduled/decoded successor (they may no longer be next) and pull in
   *  whatever is next now. keepBuffers spares the decoded buffers — right
   *  for edits that can't change what's next (append, seek), a wasted
   *  re-fetch otherwise. */
  private rechainAfterCurrent(opts: { keepBuffers: boolean }) {
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
        // maybeChain can find the anchor when the fetch lands.
        this.schedule.set(this.prevKey(current) ?? NO_PREDECESSOR, {
          startAt: this.ctx.currentTime + START_EPSILON,
          duration: 0,
        });
      }
    }
    if (!opts.keepBuffers && current != null) this.releaseBuffersExcept(current);
    if (!opts.keepBuffers && current == null) this.buffers.clear();

    if (this.status === "idle" || current == null) return;
    const next = this.nextKey(current);
    if (next == null) return;
    if (this.buffers.has(next)) this.maybeChain(next, this.session);
    else this.prefetch(next, this.session);
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
    this.rechainAfterCurrent({ keepBuffers: false });
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
    this.rechainAfterCurrent({ keepBuffers: true });
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
      this.buffers.delete(key);
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
      this.buffers.delete(key);
      this.rechainAfterCurrent({ keepBuffers: false });
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
    this.rechainAfterCurrent({ keepBuffers: false });
    this.emit();
  }

  clearQueue() {
    this.session++;
    this.stopAllSources();
    this.schedule.clear();
    this.buffers.clear();
    this.pending.clear();
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

  /** Jump within the current entry. Needs its decoded buffer (i.e. not
   *  while "loading"). Zero network cost: a new source node on the same
   *  buffer, started at `secs`, with the anchor shifted back by `secs` so
   *  getPosition() and the successor's chain arithmetic are untouched. */
  seek(secs: number) {
    const key = this.currentKey;
    const ctx = this.ctx;
    if (key == null || !ctx || !this.gain) return;
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    const offset = Math.min(Math.max(secs, 0), Math.max(buffer.duration - 0.05, 0));
    const session = this.session;

    this.stopSource(key);
    const when = ctx.currentTime + START_EPSILON;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(when, offset);
    this.sources.set(key, source);
    this.schedule.set(key, { startAt: when - offset, duration: buffer.duration });
    source.onended = () => this.handleTrackEnded(key, session);

    this.rechainAfterCurrent({ keepBuffers: true });
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
    this.rechainAfterCurrent({ keepBuffers: false });
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
    if (this.ctx && info && info.duration > 0) {
      const elapsed = Math.min(Math.max(this.ctx.currentTime - info.startAt, 0), info.duration);
      return { elapsed, duration: info.duration };
    }
    return { elapsed: 0, duration: this.duration ?? 0 };
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
