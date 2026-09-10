import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerEngine } from "./player-engine";
import type { QueueTrack } from "./player-types";

// -----------------------------------------------------------------------
// Fakes: a fake AudioContext (no jsdom/Web Audio available in this test
// environment) and a controllable loadTrack that hands back a deferred
// per call (plus a hook to deliver chunks) so tests can stream, resolve or
// reject fetches in whatever order a real network would.
// -----------------------------------------------------------------------

class FakeSourceNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  startedOffset: number | undefined = undefined;
  stopped = false;
  disconnected = false;
  started = false;

  connect() {
    // no-op — nothing in these tests inspects the graph wiring itself.
  }

  start(when?: number, offset?: number) {
    this.started = true;
    this.startedAt = when ?? 0;
    this.startedOffset = offset;
  }

  stop() {
    this.stopped = true;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeGainNode {
  gain = {
    value: 1,
    setValueAtTime(v: number) {
      this.value = v;
    },
    linearRampToValueAtTime(v: number) {
      this.value = v;
    },
    cancelScheduledValues() {
      // no-op
    },
  };
  connect() {
    // no-op
  }
}

function createFakeAudioContext() {
  const sources: FakeSourceNode[] = [];
  const gains: FakeGainNode[] = [];
  const ctx = {
    currentTime: 0,
    state: "suspended" as "suspended" | "running",
    destination: {},
    resume() {
      ctx.state = "running";
      return Promise.resolve();
    },
    suspend() {
      ctx.state = "suspended";
      return Promise.resolve();
    },
    createGain() {
      const g = new FakeGainNode();
      gains.push(g);
      return g;
    },
    createBufferSource() {
      const s = new FakeSourceNode();
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources, gains };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Progress = { loaded: number; total: number | null };
interface LoadCall {
  trackId: number;
  deferred: Deferred<void>;
  handlers: { onChunk: (chunk: AudioBuffer) => void; onProgress?: (p: Progress) => void };
  signal: AbortSignal;
}

/** Every call to loadTrack gets its own deferred (keyed by trackId, in call
 *  order) so a test can resolve/reject any specific stream — including a
 *  track requested more than once across its life in the queue — without
 *  affecting any other in-flight one. `chunk` delivers one slice of audio
 *  without finishing the stream; `resolve` is the common "one chunk, then
 *  done" shorthand. */
function createFakeLoader() {
  const calls: LoadCall[] = [];

  const loadTrack = (
    _ctx: AudioContext,
    trackId: number,
    handlers: LoadCall["handlers"],
    signal: AbortSignal,
  ): Promise<void> => {
    const deferred = createDeferred<void>();
    calls.push({ trackId, deferred, handlers, signal });
    return deferred.promise;
  };

  const callsFor = (trackId: number) => calls.filter((c) => c.trackId === trackId);
  const countFor = (trackId: number) => callsFor(trackId).length;
  const nthFor = (trackId: number, n = 0) => {
    const c = callsFor(trackId)[n];
    if (!c) throw new Error(`no loadTrack call #${n} for trackId ${trackId}`);
    return c;
  };
  const chunk = (trackId: number, durationSecs: number, n = 0) =>
    nthFor(trackId, n).handlers.onChunk({ duration: durationSecs } as unknown as AudioBuffer);
  const complete = (trackId: number, n = 0) => nthFor(trackId, n).deferred.resolve();
  const resolve = (trackId: number, durationSecs: number, n = 0) => {
    chunk(trackId, durationSecs, n);
    complete(trackId, n);
  };
  const reject = (trackId: number, err: unknown = new Error("load failed"), n = 0) =>
    nthFor(trackId, n).deferred.reject(err);
  const progress = (trackId: number, loaded: number, total: number | null, n = 0) =>
    nthFor(trackId, n).handlers.onProgress?.({ loaded, total });
  const aborted = (trackId: number, n = 0) => nthFor(trackId, n).signal.aborted;

  return { loadTrack, calls, countFor, chunk, complete, resolve, reject, progress, aborted };
}

/** Flush every pending microtask (a real macrotask tick guarantees every
 *  already-queued .then callback, however many hops deep, has run). */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

let trackIdCounter = 0;

function makeTrack(overrides: Partial<QueueTrack> = {}): QueueTrack {
  const id = ++trackIdCounter;
  return {
    trackId: id,
    title: `Track ${id}`,
    artist: "Artist",
    albumId: 1,
    albumTitle: "Album",
    hasCover: false,
    coverVersion: null,
    // Deliberately a wrong-looking DB estimate distinct from every decoded
    // duration used in tests, so any assertion on snapshot.duration proves
    // it's reading the *decoded* value, not this one.
    durationSecs: 999,
    codec: "flac",
    ...overrides,
  };
}

describe("PlayerEngine", () => {
  let fake: ReturnType<typeof createFakeAudioContext>;
  let loader: ReturnType<typeof createFakeLoader>;
  let engine: PlayerEngine;

  beforeEach(() => {
    trackIdCounter = 0;
    fake = createFakeAudioContext();
    loader = createFakeLoader();
    engine = new PlayerEngine({ createContext: () => fake.ctx, loadTrack: loader.loadTrack, primeOutput: () => {} });
  });

  // -----------------------------------------------------------------------
  // 1-2: playTracks + gapless chaining
  // -----------------------------------------------------------------------

  it("playTracks goes to loading with the first track, then to playing once its buffer resolves, requesting only the next track", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);

    let snap = engine.getSnapshot();
    expect(snap.status).toBe("loading");
    expect(snap.current?.trackId).toBe(t1.trackId);
    expect(loader.countFor(t1.trackId)).toBe(1);

    loader.resolve(t1.trackId, 137.5);
    await flush();

    snap = engine.getSnapshot();
    expect(snap.status).toBe("playing");
    expect(snap.duration).toBe(137.5); // decoded duration, not t1.durationSecs (999)
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]!.startedAt).toBeCloseTo(0.25, 5); // clock live at 0 + COLD_START_LEAD

    // Pacing: only the second track was requested — not the third.
    expect(loader.countFor(t2.trackId)).toBe(1);
    expect(loader.countFor(t3.trackId)).toBe(0);
  });

  it("chains the second track's source to start exactly when the first ends", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 42);
    await flush();

    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.25 + 100, 5);
  });

  // -----------------------------------------------------------------------
  // 3: onended advances the chain
  // -----------------------------------------------------------------------

  it("advances currentKey on onended, releases the old buffer's slot, and pulls in the entry after the new current", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    expect(loader.countFor(t3.trackId)).toBe(0);

    fake.sources[0]!.onended?.();
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t2.trackId);
    expect(snap.status).toBe("playing");
    expect(snap.duration).toBe(80);
    // Only current+next are ever kept/requested: track3 (the new "next")
    // gets requested exactly once; track1/track2 are not re-requested.
    expect(loader.countFor(t3.trackId)).toBe(1);
    expect(loader.countFor(t1.trackId)).toBe(1);
    expect(loader.countFor(t2.trackId)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4: failed load of the NEXT track is skipped, chain continues past it
  // -----------------------------------------------------------------------

  it("skips a next track that fails to load, later chaining the one after it onto the same anchor", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();

    loader.reject(t2.trackId);
    await flush();
    // The failed next track's fallout requests the one after it.
    expect(loader.countFor(t3.trackId)).toBe(1);

    // Playback reaches (skips through) track2.
    fake.sources[0]!.onended?.();
    await flush();
    expect(engine.getSnapshot().current?.trackId).toBe(t2.trackId);
    // track3's fetch was already in flight and is not re-issued.
    expect(loader.countFor(t3.trackId)).toBe(1);

    loader.resolve(t3.trackId, 55);
    await flush();

    expect(fake.sources).toHaveLength(2); // one for t1, one for t3 — none for t2
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.25 + 100, 5); // same slot t2 would have used
  });

  // -----------------------------------------------------------------------
  // 5: failed load of the CURRENT track advances immediately
  // -----------------------------------------------------------------------

  it("advances past the current track immediately if its own load fails", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);

    loader.reject(t1.trackId, new Error("HTTP 504"));
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t2.trackId);
    expect(snap.status).toBe("loading");
    expect(fake.sources).toHaveLength(0); // t1 never got a source
    // A failed load is visible in the snapshot, not just console.warn'd —
    // this is what makes an off-LAN network failure distinguishable from
    // "plays but no sound" without a laptop tethered to the console.
    expect(snap.lastError).toEqual({ title: t1.title, message: "HTTP 504" });
    // The whole point of advancing off a failed current track: the new
    // current entry must actually be requested, not just pointed at —
    // otherwise status stays "loading" (which the player bars render
    // identically to "playing") forever, with nothing ever fetched.
    expect(loader.countFor(t2.trackId)).toBe(1);
  });

  it("clears lastError once playback reaches a real (successfully decoded) track", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);

    loader.reject(t1.trackId);
    await flush();
    expect(engine.getSnapshot().lastError).not.toBeNull();

    loader.resolve(t2.trackId, 42);
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("playing");
    expect(snap.lastError).toBeNull();
  });

  it("surfaces loadProgress for the current track's fetch and clears it once scheduled", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]);
    expect(engine.getSnapshot().loadProgress).toBeNull();

    loader.progress(t1.trackId, 1024, 4096);
    expect(engine.getSnapshot().loadProgress).toEqual({ loaded: 1024, total: 4096 });

    loader.progress(t1.trackId, 4096, 4096);
    expect(engine.getSnapshot().loadProgress).toEqual({ loaded: 4096, total: 4096 });

    loader.resolve(t1.trackId, 180);
    await flush();
    expect(engine.getSnapshot().loadProgress).toBeNull();
  });

  it("does not surface progress for a background prefetch of a track that isn't current yet", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    // t2 is now being prefetched in the background while t1 plays.
    expect(loader.countFor(t2.trackId)).toBe(1);

    loader.progress(t2.trackId, 500, 2000);
    // t1 is still current — t2's own download isn't shown.
    expect(engine.getSnapshot().loadProgress).toBeNull();
  });

  it("dismissError clears lastError and is a no-op once already clear", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]);
    loader.reject(t1.trackId);
    await flush();
    expect(engine.getSnapshot().lastError).not.toBeNull();

    engine.dismissError();
    expect(engine.getSnapshot().lastError).toBeNull();

    // Second call: nothing to clear, must not throw or emit a bogus change.
    engine.dismissError();
    expect(engine.getSnapshot().lastError).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 6: playNext
  // -----------------------------------------------------------------------

  it("playNext inserts right after current, stops the old successor's source, and requests the new one", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    const oldSuccessorSource = fake.sources[1]!;
    expect(oldSuccessorSource.stopped).toBe(false);

    const tX = makeTrack();
    engine.playNext([tX]);

    const snap = engine.getSnapshot();
    expect(snap.queue.map((e) => e.trackId)).toEqual([t1.trackId, tX.trackId, t2.trackId, t3.trackId]);
    expect(snap.order.map((k) => snap.queue.find((e) => e.key === k)!.trackId)).toEqual([
      t1.trackId,
      tX.trackId,
      t2.trackId,
      t3.trackId,
    ]);
    expect(oldSuccessorSource.stopped).toBe(true);
    expect(loader.countFor(tX.trackId)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 7: addToQueue
  // -----------------------------------------------------------------------

  it("addToQueue requests the appended track when current was the last entry", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]);
    loader.resolve(t1.trackId, 100);
    await flush();

    const t2 = makeTrack();
    engine.addToQueue([t2]);
    await flush();

    expect(loader.countFor(t2.trackId)).toBe(1);
    expect(engine.getSnapshot().queue.map((e) => e.trackId)).toEqual([t1.trackId, t2.trackId]);
  });

  it("addToQueue with an empty queue starts playing", () => {
    const t1 = makeTrack();
    engine.addToQueue([t1]);

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("loading");
    expect(snap.current?.trackId).toBe(t1.trackId);
    expect(loader.countFor(t1.trackId)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 8: removeFromQueue
  // -----------------------------------------------------------------------

  it("removeFromQueue(currentKey) while playing starts the successor", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    const currentKey = engine.getSnapshot().currentKey!;
    const callsBefore = loader.countFor(t2.trackId);
    engine.removeFromQueue(currentKey);

    const snap = engine.getSnapshot();
    // t2 was already prefetched (resolved above) — starting it should go
    // straight to playing, not re-download bytes already sitting decoded
    // in memory (see startFrom's buffer-preservation comment).
    expect(snap.status).toBe("playing");
    expect(snap.current?.trackId).toBe(t2.trackId);
    expect(loader.countFor(t2.trackId)).toBe(callsBefore);
  });

  it("removeFromQueue of a non-current, non-next entry does not stop anything", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    const t3Key = engine.getSnapshot().queue.find((e) => e.trackId === t3.trackId)!.key;
    const callsBefore = loader.calls.length;
    engine.removeFromQueue(t3Key);

    expect(fake.sources[0]!.stopped).toBe(false);
    expect(fake.sources[1]!.stopped).toBe(false);
    expect(loader.calls.length).toBe(callsBefore);
    expect(engine.getSnapshot().queue.map((e) => e.trackId)).toEqual([t1.trackId, t2.trackId]);
  });

  // -----------------------------------------------------------------------
  // 9: moveInQueue
  // -----------------------------------------------------------------------

  it("moveInQueue reorders order (and queue, shuffle off) and re-chains", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    const oldSuccessorSource = fake.sources[1]!;
    const t3Key = engine.getSnapshot().queue.find((e) => e.trackId === t3.trackId)!.key;
    engine.moveInQueue(t3Key, 1); // move t3 to right after current

    const snap = engine.getSnapshot();
    expect(snap.order.map((k) => snap.queue.find((e) => e.key === k)!.trackId)).toEqual([
      t1.trackId,
      t3.trackId,
      t2.trackId,
    ]);
    expect(snap.queue.map((e) => e.trackId)).toEqual([t1.trackId, t3.trackId, t2.trackId]);
    expect(oldSuccessorSource.stopped).toBe(true); // t2 was bumped out of "next"
    expect(loader.countFor(t3.trackId)).toBe(1); // the new successor got requested
  });

  // -----------------------------------------------------------------------
  // 10: shuffle
  // -----------------------------------------------------------------------

  it("setShuffle(true) keeps current first and every key exactly once; setShuffle(false) restores insertion order", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const tracks = [makeTrack(), makeTrack(), makeTrack(), makeTrack()];
      engine.playTracks(tracks);
      loader.resolve(tracks[0]!.trackId, 100);
      await flush();

      const currentKey = engine.getSnapshot().currentKey!;
      const insertionOrder = engine.getSnapshot().queue.map((e) => e.key);

      engine.setShuffle(true);
      let snap = engine.getSnapshot();
      expect(snap.shuffle).toBe(true);
      expect(snap.order[0]).toBe(currentKey);
      expect([...snap.order].sort()).toEqual([...insertionOrder].sort());
      expect(snap.order).toHaveLength(insertionOrder.length);

      engine.setShuffle(false);
      snap = engine.getSnapshot();
      expect(snap.shuffle).toBe(false);
      expect(snap.order).toEqual(insertionOrder);
    } finally {
      randomSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // 11: repeat
  // -----------------------------------------------------------------------

  it("repeat on: onended on the last entry restarts from order[0]", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    fake.sources[0]!.onended?.(); // advance to t2 (the last entry)
    await flush();
    expect(engine.getSnapshot().current?.trackId).toBe(t2.trackId);

    engine.setRepeat(true);
    fake.sources[1]!.onended?.(); // t2's own source (index 0 is t1's, already fired)
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("loading");
    expect(snap.current?.trackId).toBe(t1.trackId);
    expect(snap.currentKey).toBe(snap.order[0]);
  });

  it("repeat off: onended on the last entry goes idle at order[0]", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    fake.sources[0]!.onended?.();
    await flush();

    fake.sources[1]!.onended?.(); // t2's own source (index 0 is t1's, already fired)
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("idle");
    expect(snap.currentKey).toBe(snap.order[0]);
  });

  // -----------------------------------------------------------------------
  // 12: seek
  // -----------------------------------------------------------------------

  it("seek creates a new source at the given offset and getPosition tracks it; seek while loading is a no-op", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]);
    loader.resolve(t1.trackId, 200);
    await flush();

    (fake.ctx as unknown as { currentTime: number }).currentTime = 10;
    engine.seek(30);

    expect(fake.sources).toHaveLength(2);
    const seekSource = fake.sources[1]!;
    expect(seekSource.startedAt).toBeCloseTo(10.1, 5);
    expect(seekSource.startedOffset).toBeCloseTo(30, 5);
    expect(fake.sources[0]!.stopped).toBe(true); // old source stopped

    // Advance the clock by the START_EPSILON lead-in the source was
    // scheduled with, so elapsed reads exactly the seek target.
    (fake.ctx as unknown as { currentTime: number }).currentTime = 10.1;
    const pos = engine.getPosition();
    expect(pos?.elapsed).toBeCloseTo(30, 5);
  });

  it("seek while the current track is still loading (no decoded buffer) is a no-op", () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]); // t1 never resolved — still "loading"
    const snapBefore = engine.getSnapshot();
    const sourceCountBefore = fake.sources.length;

    engine.seek(5);

    expect(fake.sources).toHaveLength(sourceCountBefore);
    expect(engine.getSnapshot()).toBe(snapBefore); // no emit — nothing changed
  });

  // -----------------------------------------------------------------------
  // 13: pause/play
  // -----------------------------------------------------------------------

  it("pause suspends the context, play resumes; a buffer resolving while paused leaves status paused", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]); // still loading

    engine.pause();
    expect(fake.ctx.state).toBe("suspended");
    expect(engine.getSnapshot().status).toBe("paused");

    loader.resolve(t1.trackId, 50);
    await flush();
    expect(engine.getSnapshot().status).toBe("paused");
    expect(engine.getSnapshot().duration).toBe(50); // duration still updates

    engine.play();
    expect(fake.ctx.state).toBe("running");
    expect(engine.getSnapshot().status).toBe("playing");
  });

  // -----------------------------------------------------------------------
  // 13.5: next
  // -----------------------------------------------------------------------

  it("next reuses an already-prefetched successor's buffer instead of re-downloading it", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    // Normal prefetch pacing already pulled t2 in while t1 plays.
    loader.resolve(t2.trackId, 80);
    await flush();
    const callsBefore = loader.countFor(t2.trackId);

    engine.next();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t2.trackId);
    expect(snap.status).toBe("playing");
    expect(loader.countFor(t2.trackId)).toBe(callsBefore); // not re-requested
  });

  it("next while the successor is still mid-fetch keeps that stream rather than re-requesting it", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    // t2's stream is in flight (requested once t1's own stream completed).
    expect(loader.countFor(t2.trackId)).toBe(1);

    engine.next();

    // The in-flight stream is the one the new current entry wants — it
    // carries on under the new session instead of being orphaned and
    // fetched a second time.
    expect(engine.getSnapshot().status).toBe("loading");
    expect(loader.countFor(t2.trackId)).toBe(1);
    expect(loader.aborted(t2.trackId)).toBe(false);

    loader.resolve(t2.trackId, 80);
    await flush();
    expect(engine.getSnapshot().status).toBe("playing");
    expect(engine.getSnapshot().duration).toBe(80);
  });

  // -----------------------------------------------------------------------
  // 14: previous
  // -----------------------------------------------------------------------

  it("previous restarts the current track once elapsed > 3s, reusing its already-decoded buffer", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();

    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.1 + 5; // 5s elapsed
    const callsBefore = loader.countFor(t1.trackId);
    engine.previous();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t1.trackId); // restarted, not stepped back
    // t1 is the track already playing — its buffer never left memory, so
    // restarting it goes straight to playing rather than re-downloading
    // the exact same bytes (see startFrom's buffer-preservation comment).
    expect(snap.status).toBe("playing");
    expect(loader.countFor(t1.trackId)).toBe(callsBefore);
  });

  it("previous steps back to the previous entry when elapsed <= 3s", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    fake.sources[0]!.onended?.(); // advance to t2
    await flush();
    expect(engine.getSnapshot().current?.trackId).toBe(t2.trackId);

    // t2 has barely started (schedule.startAt ~= 0.1 + 100; keep currentTime there)
    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.1 + 100 + 1; // 1s elapsed
    engine.previous();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t1.trackId);
  });

  // -----------------------------------------------------------------------
  // 15: late-resolving buffer for an entry that's no longer current/next
  // -----------------------------------------------------------------------

  it("discards a buffer that resolves for an entry no longer current or next, and re-requests it once it becomes next again", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    const t3 = makeTrack();
    engine.playTracks([t1, t2, t3]);
    loader.resolve(t1.trackId, 100);
    await flush(); // t2 requested (call #1)
    expect(loader.countFor(t2.trackId)).toBe(1);

    // Bump something else in right after current, displacing t2 as "next".
    const tX = makeTrack();
    engine.playNext([tX]);
    await flush();

    const sourcesBeforeLateResolve = fake.sources.length;
    loader.resolve(t2.trackId, 80); // the original, now-stale fetch resolves late
    await flush();

    // No source was created for the discarded buffer.
    expect(fake.sources).toHaveLength(sourcesBeforeLateResolve);

    // Removing tX makes t2 "next" again — it should be re-requested since
    // its late buffer was discarded rather than kept.
    const tXKey = engine.getSnapshot().queue.find((e) => e.trackId === tX.trackId)!.key;
    engine.removeFromQueue(tXKey);
    await flush();

    expect(loader.countFor(t2.trackId)).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 15.5: progressive (chunked) delivery
  // -----------------------------------------------------------------------

  it("starts playing on the first chunk and schedules each later chunk contiguously after it", async () => {
    const t1 = makeTrack({ durationSecs: 3 });
    engine.playTracks([t1]);
    await flush(); // resume() settled — the clock is live

    loader.chunk(t1.trackId, 0.5);
    let snap = engine.getSnapshot();
    expect(snap.status).toBe("playing"); // no waiting for the rest
    expect(snap.duration).toBe(3); // DB estimate until the stream completes
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]!.startedAt).toBeCloseTo(0.25, 5); // COLD_START_LEAD past the clock coming alive

    loader.chunk(t1.trackId, 0.5);
    loader.chunk(t1.trackId, 0.25);
    expect(fake.sources).toHaveLength(3);
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.75, 5);
    expect(fake.sources[2]!.startedAt).toBeCloseTo(1.25, 5);

    loader.complete(t1.trackId);
    await flush();
    snap = engine.getSnapshot();
    expect(snap.duration).toBeCloseTo(1.25, 5); // real total once complete
  });

  it("requests the successor only once the current entry's own stream has completed", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    await flush();

    loader.chunk(t1.trackId, 0.5);
    loader.chunk(t1.trackId, 0.5);
    expect(engine.getSnapshot().status).toBe("playing");
    expect(loader.countFor(t2.trackId)).toBe(0); // still streaming t1 — don't compete with it

    loader.complete(t1.trackId);
    await flush();
    expect(loader.countFor(t2.trackId)).toBe(1);
  });

  it("holds a successor's chunks until the predecessor's end is known, then chains them at that instant", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();

    // t2 streams in two chunks; both land while t1 plays.
    loader.chunk(t2.trackId, 0.5);
    loader.chunk(t2.trackId, 0.5);
    expect(fake.sources).toHaveLength(3);
    expect(fake.sources[1]!.startedAt).toBeCloseTo(100.25, 5);
    expect(fake.sources[2]!.startedAt).toBeCloseTo(100.75, 5);
  });

  it("a chunk that lands after its slot shifts the anchor forward (a pause, not a skip)", async () => {
    const t1 = makeTrack();
    engine.playTracks([t1]);
    await flush();
    loader.chunk(t1.trackId, 0.5); // scheduled at 0.25, runs to 0.75

    // The network stalls: the next chunk only arrives at t=2.
    (fake.ctx as unknown as { currentTime: number }).currentTime = 2;
    loader.chunk(t1.trackId, 0.5);

    expect(fake.sources[1]!.startedAt).toBeCloseTo(2.1, 5);
    expect(fake.sources[1]!.startedOffset).toBe(0); // nothing skipped
    // Position picks up where the audio left off (0.5 s in), not 2 s in.
    (fake.ctx as unknown as { currentTime: number }).currentTime = 2.1;
    expect(engine.getPosition()?.elapsed).toBeCloseTo(0.5, 5);
  });

  it("ends the track when its last chunk ends — even if the stream's completion lands after that", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    await flush();
    loader.chunk(t1.trackId, 0.5);

    fake.sources[0]!.onended?.(); // the only chunk so far finishes playing
    expect(engine.getSnapshot().current?.trackId).toBe(t1.trackId); // not known to be the last yet

    loader.complete(t1.trackId);
    await flush();
    expect(engine.getSnapshot().current?.trackId).toBe(t2.trackId);
    expect(loader.countFor(t2.trackId)).toBe(1);
  });

  it("a stream that fails part-way plays what arrived, flags the error, and moves on at the end of it", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    await flush();
    loader.chunk(t1.trackId, 0.5);
    loader.chunk(t1.trackId, 0.5);

    loader.reject(t1.trackId, new Error("network dropped"));
    await flush();

    let snap = engine.getSnapshot();
    expect(snap.status).toBe("playing");
    expect(snap.lastError).toEqual({ title: t1.title, message: "network dropped" });
    expect(snap.duration).toBeCloseTo(1, 5); // what we have is all there is
    expect(loader.countFor(t2.trackId)).toBe(1); // successor pulled in as if the stream had completed

    fake.sources[1]!.onended?.(); // the last chunk that did arrive
    await flush();
    snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t2.trackId);
  });

  it("aborts a successor's stream when a queue edit displaces it", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.chunk(t2.trackId, 0.5); // t2 streaming, partly here
    expect(loader.aborted(t2.trackId)).toBe(false);

    engine.playNext([makeTrack()]);

    expect(loader.aborted(t2.trackId)).toBe(true);
  });

  it("seek is clamped to the audio that has arrived while the stream is still in flight", async () => {
    const t1 = makeTrack({ durationSecs: 300 });
    engine.playTracks([t1]);
    await flush();
    loader.chunk(t1.trackId, 0.5);
    loader.chunk(t1.trackId, 0.5); // 1 s downloaded of a 300 s track

    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.3;
    engine.seek(200);

    // Clamped to the 1 s that's here: both chunks are behind that point,
    // so nothing restarts and the position parks at 1 s until more lands.
    expect(fake.sources.every((s) => s.stopped)).toBe(true);
    expect(fake.sources).toHaveLength(2);
    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.4;
    expect(engine.getPosition()?.elapsed).toBeCloseTo(1, 5);

    // The next chunk is exactly the audio at the seek point: it starts now.
    loader.chunk(t1.trackId, 0.5);
    expect(fake.sources).toHaveLength(3);
    expect(fake.sources[2]!.startedAt).toBeCloseTo(0.5, 5); // 0.4 + START_EPSILON
    expect(fake.sources[2]!.startedOffset).toBe(0);
  });

  it("holds the first chunk until the context's resume() has resolved, then starts it with the full lead", async () => {
    let resolveResume!: () => void;
    (fake.ctx as unknown as { resume: () => Promise<void> }).resume = () =>
      new Promise<void>((r) => {
        resolveResume = r;
      });
    const t1 = makeTrack();
    engine.playTracks([t1]);

    loader.chunk(t1.trackId, 0.5); // lands while the device is still coming up
    loader.chunk(t1.trackId, 0.5);
    expect(fake.sources).toHaveLength(0);
    expect(engine.getSnapshot().status).toBe("loading");

    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.2; // clock now live
    resolveResume();
    await flush();

    expect(engine.getSnapshot().status).toBe("playing");
    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[0]!.startedAt).toBeCloseTo(0.45, 5); // 0.2 + COLD_START_LEAD, not the stale seed
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.95, 5);
    expect(fake.gains[0]!.gain.value).toBe(0.85); // faded up to the set volume
  });

  // -----------------------------------------------------------------------
  // 16: snapshot identity + subscribe
  // -----------------------------------------------------------------------

  it("getSnapshot is referentially stable between mutations, and subscribe stops firing after unsubscribe", () => {
    const snap1 = engine.getSnapshot();
    expect(engine.getSnapshot()).toBe(snap1);

    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    engine.setVolume(0.5);
    expect(listener).toHaveBeenCalledTimes(1);
    const snap2 = engine.getSnapshot();
    expect(snap2).not.toBe(snap1);
    expect(snap2.volume).toBe(0.5);

    unsubscribe();
    engine.setRepeat(true);
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  // -----------------------------------------------------------------------
  // 17: setVolume
  // -----------------------------------------------------------------------

  it("setVolume clamps to [0,1] and writes the gain value", () => {
    const t1 = makeTrack();
    engine.playTracks([t1]); // forces ensureContext() -> creates the gain node

    engine.setVolume(1.5);
    expect(engine.getSnapshot().volume).toBe(1);
    expect(fake.gains[0]!.gain.value).toBe(1);

    engine.setVolume(-1);
    expect(engine.getSnapshot().volume).toBe(0);
    expect(fake.gains[0]!.gain.value).toBe(0);

    engine.setVolume(0.42);
    expect(engine.getSnapshot().volume).toBe(0.42);
    expect(fake.gains[0]!.gain.value).toBe(0.42);
  });

  // -----------------------------------------------------------------------
  // 18: clearQueue
  // -----------------------------------------------------------------------

  it("clearQueue empties everything and stops every source", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();
    loader.resolve(t2.trackId, 80);
    await flush();

    expect(fake.sources).toHaveLength(2);
    engine.clearQueue();

    expect(fake.sources.every((s) => s.stopped)).toBe(true);
    const snap = engine.getSnapshot();
    expect(snap.queue).toEqual([]);
    expect(snap.order).toEqual([]);
    expect(snap.currentKey).toBeNull();
    expect(snap.status).toBe("idle");
  });
});
