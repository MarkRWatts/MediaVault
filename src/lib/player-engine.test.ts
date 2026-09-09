import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerEngine } from "./player-engine";
import type { QueueTrack } from "./player-types";

// -----------------------------------------------------------------------
// Fakes: a fake AudioContext (no jsdom/Web Audio available in this test
// environment) and a controllable loadBuffer that hands back a deferred
// per call so tests can resolve/reject fetches in whatever order a real
// network would.
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
  gain = { value: 1 };
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

/** Every call to loadBuffer gets its own deferred (keyed by trackId, in call
 *  order) so a test can resolve/reject any specific fetch — including a
 *  track requested more than once across its life in the queue — without
 *  affecting any other in-flight fetch. */
function createFakeLoader() {
  const calls: { trackId: number; deferred: Deferred<AudioBuffer> }[] = [];

  const loadBuffer = (_ctx: AudioContext, trackId: number): Promise<AudioBuffer> => {
    const deferred = createDeferred<AudioBuffer>();
    calls.push({ trackId, deferred });
    return deferred.promise;
  };

  const callsFor = (trackId: number) => calls.filter((c) => c.trackId === trackId);
  const countFor = (trackId: number) => callsFor(trackId).length;
  const nthFor = (trackId: number, n = 0) => {
    const c = callsFor(trackId)[n];
    if (!c) throw new Error(`no loadBuffer call #${n} for trackId ${trackId}`);
    return c.deferred;
  };
  const resolve = (trackId: number, durationSecs: number, n = 0) =>
    nthFor(trackId, n).resolve({ duration: durationSecs } as unknown as AudioBuffer);
  const reject = (trackId: number, err: unknown = new Error("load failed"), n = 0) =>
    nthFor(trackId, n).reject(err);

  return { loadBuffer, calls, countFor, resolve, reject };
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
    engine = new PlayerEngine({ createContext: () => fake.ctx, loadBuffer: loader.loadBuffer });
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
    expect(fake.sources[0]!.startedAt).toBeCloseTo(0.05, 5); // ctx.currentTime(0) + START_EPSILON

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
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.05 + 100, 5);
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
    expect(fake.sources[1]!.startedAt).toBeCloseTo(0.05 + 100, 5); // same slot t2 would have used
  });

  // -----------------------------------------------------------------------
  // 5: failed load of the CURRENT track advances immediately
  // -----------------------------------------------------------------------

  it("advances past the current track immediately if its own load fails", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);

    loader.reject(t1.trackId);
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.current?.trackId).toBe(t2.trackId);
    expect(snap.status).toBe("loading");
    expect(fake.sources).toHaveLength(0); // t1 never got a source
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
    engine.removeFromQueue(currentKey);

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("loading");
    expect(snap.current?.trackId).toBe(t2.trackId);
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
    expect(seekSource.startedAt).toBeCloseTo(10.05, 5);
    expect(seekSource.startedOffset).toBeCloseTo(30, 5);
    expect(fake.sources[0]!.stopped).toBe(true); // old source stopped

    // Advance the clock by the START_EPSILON lead-in the source was
    // scheduled with, so elapsed reads exactly the seek target.
    (fake.ctx as unknown as { currentTime: number }).currentTime = 10.05;
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
  // 14: previous
  // -----------------------------------------------------------------------

  it("previous restarts the current track once elapsed > 3s", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack();
    engine.playTracks([t1, t2]);
    loader.resolve(t1.trackId, 100);
    await flush();

    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.05 + 5; // 5s elapsed
    const callsBefore = loader.countFor(t1.trackId);
    engine.previous();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe("loading");
    expect(snap.current?.trackId).toBe(t1.trackId); // restarted, not stepped back
    expect(loader.countFor(t1.trackId)).toBe(callsBefore + 1); // re-requested
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

    // t2 has barely started (schedule.startAt ~= 0.05 + 100; keep currentTime there)
    (fake.ctx as unknown as { currentTime: number }).currentTime = 0.05 + 100 + 1; // 1s elapsed
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
