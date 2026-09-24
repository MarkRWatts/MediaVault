import { describe, expect, it } from "vitest";
import { MIN_FREE_DISK_BYTES } from "@/lib/video-cache";
import {
  CATCH_UP_LOOKAHEAD,
  KEEP_BEHIND_SEGMENTS,
  PLAN_VERSION,
  TRIM_FREE_DISK_LOW_WATER_BYTES,
  TRIM_HYSTERESIS,
  THROTTLE_AHEAD_COPY,
  THROTTLE_AHEAD_TRANSCODE,
  THROTTLE_RESUME_COPY,
  THROTTLE_RESUME_TRANSCODE,
  WAIT_AHEAD_COPY,
  WAIT_AHEAD_TRANSCODE,
  checkSegmentDuration,
  decideSegment,
  isHeadCaughtUp,
  isPlanStale,
  segmentDurationTolerance,
  segmentContainerFor,
  segmentTableHash,
  selectSegmentsToTrim,
  selectStreamsToEvict,
  throttleAction,
  throttleWatermarks,
  tierFor,
  trimBytesNeeded,
  waitAheadFor,
  type LiveHead,
  type SegmentDurationCheckInput,
  type StreamCacheEntry,
  type StreamPlanIdentity,
  type TrimCandidateStream,
} from "./decisions";
import type { SegmentEntry } from "./types";

const head = (headId: string, sessionId: string, nextIndex: number): LiveHead => ({ headId, sessionId, nextIndex });

describe("tierFor", () => {
  it("is copy only for the Original variant of a video the planner can copy", () => {
    expect(tierFor("original", "copy")).toBe("copy");
  });

  it("is transcode for Original when the codec doesn't survive as-is", () => {
    expect(tierFor("original", "transcode")).toBe("transcode");
  });

  it("is always transcode for Remote, whatever the source codec is", () => {
    expect(tierFor("remote", "copy")).toBe("transcode");
    expect(tierFor("remote", "transcode")).toBe("transcode");
  });
});

describe("decideSegment", () => {
  it("serves a segment that is already on disk, whatever the heads are doing", () => {
    expect(
      decideSegment({ index: 5, onDisk: true, heads: [head("h1", "s1", 0)], sessionId: "s1", tier: "copy" }),
    ).toEqual({ action: "serve" });
  });

  it("starts a head when nothing is running", () => {
    expect(decideSegment({ index: 0, onDisk: false, heads: [], sessionId: "s1", tier: "transcode" })).toEqual({
      action: "start",
      stopHeadId: null,
    });
  });

  it("waits for a head that is at or just behind the request", () => {
    for (const behind of [0, 1, WAIT_AHEAD_TRANSCODE]) {
      expect(
        decideSegment({
          index: 10,
          onDisk: false,
          heads: [head("h1", "s1", 10 - behind)],
          sessionId: "s1",
          tier: "transcode",
        }),
      ).toEqual({ action: "wait", headId: "h1" });
    }
  });

  it("restarts rather than waiting for a head further behind than the tier allows", () => {
    expect(
      decideSegment({
        index: 10,
        onDisk: false,
        heads: [head("h1", "s1", 10 - WAIT_AHEAD_TRANSCODE - 1)],
        sessionId: "s1",
        tier: "transcode",
      }),
    ).toEqual({ action: "start", stopHeadId: "h1" });
  });

  it("gives a copy-tier head a much longer leash than a transcode one", () => {
    const heads = [head("h1", "s1", 0)];
    const at = (tier: "copy" | "transcode", index: number) =>
      decideSegment({ index, onDisk: false, heads, sessionId: "s1", tier });

    expect(at("transcode", WAIT_AHEAD_COPY)).toEqual({ action: "start", stopHeadId: "h1" });
    expect(at("copy", WAIT_AHEAD_COPY)).toEqual({ action: "wait", headId: "h1" });
    expect(at("copy", WAIT_AHEAD_COPY + 1)).toEqual({ action: "start", stopHeadId: "h1" });
    expect(waitAheadFor("copy")).toBeGreaterThan(waitAheadFor("transcode"));
  });

  it("never waits for a head that is already PAST the request -- it will not come back", () => {
    expect(
      decideSegment({ index: 4, onDisk: false, heads: [head("h1", "s1", 5)], sessionId: "s1", tier: "copy" }),
    ).toEqual({ action: "start", stopHeadId: "h1" });
  });

  it("waits for the closest of several reachable heads", () => {
    expect(
      decideSegment({
        index: 10,
        onDisk: false,
        heads: [head("far", "s2", 8), head("near", "s3", 9), head("behind", "s4", 7)],
        sessionId: "s1",
        tier: "copy",
      }),
    ).toEqual({ action: "wait", headId: "near" });
  });

  it("stops only the requesting session's own head when it has to restart", () => {
    const heads = [head("mine", "s1", 40), head("theirs", "s2", 41)];
    expect(decideSegment({ index: 0, onDisk: false, heads, sessionId: "s1", tier: "copy" })).toEqual({
      action: "start",
      stopHeadId: "mine",
    });
    // A third viewer restarting takes neither of the other two down.
    expect(decideSegment({ index: 0, onDisk: false, heads, sessionId: "s3", tier: "copy" })).toEqual({
      action: "start",
      stopHeadId: null,
    });
  });

  it("prefers waiting for ANOTHER session's nearby head over restarting its own distant one", () => {
    // Two viewers of the same film: one has been playing from the start,
    // the other just seeked to where the first one is. Nothing is gained by
    // killing the second viewer's stale head and starting a third process.
    expect(
      decideSegment({
        index: 20,
        onDisk: false,
        heads: [head("theirs", "s2", 19), head("mine", "s1", 3)],
        sessionId: "s1",
        tier: "transcode",
      }),
    ).toEqual({ action: "wait", headId: "theirs" });
  });
});

describe("isHeadCaughtUp", () => {
  const existing = (...indexes: number[]) => (i: number) => indexes.includes(i);

  it("is not caught up when the next segment is missing", () => {
    expect(isHeadCaughtUp(4, 100, existing(5, 6, 7))).toBe(false);
  });

  it("is not caught up on a lone island of existing segments", () => {
    expect(isHeadCaughtUp(4, 100, existing(4))).toBe(false);
    expect(isHeadCaughtUp(4, 100, existing(4, 5))).toBe(false);
  });

  it("is caught up once the lookahead run is complete", () => {
    const run = Array.from({ length: CATCH_UP_LOOKAHEAD }, (_, i) => 4 + i);
    expect(isHeadCaughtUp(4, 100, existing(...run))).toBe(true);
  });

  it("is caught up past the end of the table, and near it needs only what exists", () => {
    expect(isHeadCaughtUp(10, 10, () => false)).toBe(true);
    // Two segments left, both written: there is nothing further to check.
    expect(isHeadCaughtUp(8, 10, existing(8, 9))).toBe(true);
    expect(isHeadCaughtUp(8, 10, existing(8))).toBe(false);
  });
});

describe("throttleAction", () => {
  it("does nothing before any segment has been requested", () => {
    expect(throttleAction({ nextIndex: 9999, highestRequested: null, paused: false, tier: "copy" })).toBeNull();
  });

  it("pauses a head that has run past the tier's watermark", () => {
    const at = (tier: "copy" | "transcode", gap: number) =>
      throttleAction({ nextIndex: 100 + gap, highestRequested: 100, paused: false, tier });

    expect(at("transcode", THROTTLE_AHEAD_TRANSCODE)).toBeNull();
    expect(at("transcode", THROTTLE_AHEAD_TRANSCODE + 1)).toBe("pause");
    expect(at("copy", THROTTLE_AHEAD_TRANSCODE + 1)).toBeNull();
    expect(at("copy", THROTTLE_AHEAD_COPY + 1)).toBe("pause");
  });

  it("resumes only once the viewer has closed the gap to the lower watermark", () => {
    const at = (tier: "copy" | "transcode", gap: number) =>
      throttleAction({ nextIndex: 100 + gap, highestRequested: 100, paused: true, tier });

    expect(at("transcode", THROTTLE_RESUME_TRANSCODE + 1)).toBeNull();
    expect(at("transcode", THROTTLE_RESUME_TRANSCODE)).toBe("resume");
    expect(at("copy", THROTTLE_RESUME_COPY)).toBe("resume");
  });

  it("has a hysteresis band, so a viewer sitting on the boundary cannot flap it", () => {
    for (const tier of ["copy", "transcode"] as const) {
      const { pauseAt, resumeAt } = throttleWatermarks(tier);
      expect(resumeAt).toBeLessThan(pauseAt);
      // Exactly at the pause watermark, a paused head stays paused and a
      // running head keeps running -- neither transition fires.
      const onBoundary = { nextIndex: 100 + pauseAt, highestRequested: 100, tier };
      expect(throttleAction({ ...onBoundary, paused: false })).toBeNull();
      expect(throttleAction({ ...onBoundary, paused: true })).toBeNull();
    }
  });

  it("resumes a paused head the viewer has caught up with or overtaken", () => {
    expect(throttleAction({ nextIndex: 100, highestRequested: 100, paused: true, tier: "copy" })).toBe("resume");
    expect(throttleAction({ nextIndex: 100, highestRequested: 140, paused: true, tier: "copy" })).toBe("resume");
  });
});

describe("segmentTableHash / isPlanStale", () => {
  const table = (starts: number[]): SegmentEntry[] =>
    starts.map((start, index) => ({ index, start, duration: (starts[index + 1] ?? starts[starts.length - 1] + 6) - start }));

  const identity = (over: Partial<StreamPlanIdentity> = {}): StreamPlanIdentity => ({
    key: "film-7-original-a1",
    sourceMtimeMs: 1_700_000_000_000,
    sourceSizeBytes: 42_000_000,
    segmentCount: 3,
    container: "ts",
    tableHash: segmentTableHash(table([0, 6, 12])),
    ...over,
  });

  const planFor = (id: StreamPlanIdentity) => ({ version: PLAN_VERSION, ...id });

  it("hashes the same table to the same digest and different tables apart", () => {
    expect(segmentTableHash(table([0, 6, 12]))).toBe(segmentTableHash(table([0, 6, 12])));
    expect(segmentTableHash(table([0, 6, 12]))).not.toBe(segmentTableHash(table([0, 5, 12])));
  });

  it("accepts a plan that matches in every field", () => {
    expect(isPlanStale(planFor(identity()), identity())).toBe(false);
  });

  it("reads a plan from before fMP4 as MPEG-TS, and discards it for an fMP4 stream", () => {
    const legacy: Record<string, unknown> = { ...planFor(identity()) };
    delete legacy.container;
    expect(isPlanStale(legacy, identity())).toBe(false);
    expect(isPlanStale(legacy, identity({ container: "fmp4" }))).toBe(true);
    expect(isPlanStale(planFor(identity({ container: "fmp4" })), identity({ container: "fmp4" }))).toBe(false);
  });

  it("puts only copied HEVC in fMP4", () => {
    expect(segmentContainerFor("original", { videoAction: "copy", hevcTag: true })).toBe("fmp4");
    expect(segmentContainerFor("original", { videoAction: "copy", hevcTag: false })).toBe("ts");
    expect(segmentContainerFor("original", { videoAction: "transcode", hevcTag: false })).toBe("ts");
    expect(segmentContainerFor("remote", { videoAction: "copy", hevcTag: true })).toBe("ts");
  });

  it("rejects a plan whose source file has changed", () => {
    expect(isPlanStale(planFor(identity()), identity({ sourceMtimeMs: 1_700_000_000_001 }))).toBe(true);
    expect(isPlanStale(planFor(identity()), identity({ sourceSizeBytes: 42_000_001 }))).toBe(true);
  });

  it("rejects a plan whose segment table has changed, even at the same mtime and size", () => {
    // A rebuilt keyframe index, or a changed segment length: same bytes on
    // the share, different cuts -- the old segments no longer line up with
    // the playlist the player would be handed.
    expect(isPlanStale(planFor(identity()), identity({ tableHash: segmentTableHash(table([0, 7, 12])) }))).toBe(true);
    expect(isPlanStale(planFor(identity()), identity({ segmentCount: 4 }))).toBe(true);
  });

  it("rejects a plan for a different key, an older version, and anything unreadable", () => {
    expect(isPlanStale(planFor(identity({ key: "film-7-original-a2" })), identity())).toBe(true);
    expect(isPlanStale({ ...planFor(identity()), version: PLAN_VERSION - 1 }, identity())).toBe(true);
    for (const junk of [null, undefined, "", 7, [], {}]) {
      expect(isPlanStale(junk, identity())).toBe(true);
    }
  });
});

describe("selectStreamsToEvict", () => {
  const entry = (key: string, size: number, ageMinutes: number): StreamCacheEntry => ({
    key,
    path: `/cache/${key}`,
    size,
    atimeMs: Date.now() - ageMinutes * 60_000,
  });

  it("evicts nothing while the total is within budget", () => {
    expect(selectStreamsToEvict([entry("a", 100, 0), entry("b", 100, 60)], 500, () => false)).toEqual([]);
  });

  it("evicts least-recently-played first, and only as far as it must", () => {
    const entries = [entry("new", 100, 1), entry("old", 100, 300), entry("middling", 100, 60)];
    expect(selectStreamsToEvict(entries, 250, () => false)).toEqual(["/cache/old"]);
    expect(selectStreamsToEvict(entries, 150, () => false)).toEqual(["/cache/old", "/cache/middling"]);
  });

  it("never evicts a pinned stream, even when it is the oldest and the biggest", () => {
    const entries = [entry("watching", 1000, 300), entry("cold", 100, 1)];
    expect(selectStreamsToEvict(entries, 200, (key) => key === "watching")).toEqual(["/cache/cold"]);
  });

  it("counts pinned streams toward the total, so a live head forces others out", () => {
    const entries = [entry("live", 400, 0), entry("cold-a", 100, 300), entry("cold-b", 100, 200)];
    // Without the pinned 400 counted, 200 of cold entries would fit in 500.
    expect(selectStreamsToEvict(entries, 500, (key) => key === "live")).toEqual(["/cache/cold-a"]);
  });

  it("treats a partial directory as an ordinary entry, not as something to protect", () => {
    // "partial directories are valid entries" (V4_PLAN.md) -- only a live
    // head or a recent session pins one, and this one has neither.
    const entries = [entry("half-written", 900, 300), entry("recent", 100, 0)];
    expect(selectStreamsToEvict(entries, 200, () => false)).toEqual(["/cache/half-written"]);
  });
});

describe("segmentDurationTolerance", () => {
  it("is a quarter second for ordinary frame rates", () => {
    expect(segmentDurationTolerance(25)).toBeCloseTo(0.25, 6);
    expect(segmentDurationTolerance(23.976)).toBeCloseTo(0.25, 6);
  });

  it("widens to two frames when those are longer than the floor", () => {
    expect(segmentDurationTolerance(5)).toBeCloseTo(0.4, 6);
  });

  it("falls back to the floor when the container states no frame rate", () => {
    expect(segmentDurationTolerance(null)).toBeCloseTo(0.25, 6);
    expect(segmentDurationTolerance(0)).toBeCloseTo(0.25, 6);
  });
});

describe("checkSegmentDuration", () => {
  // A 6s table of five segments; index 4 is the last.
  const check = (over: Partial<SegmentDurationCheckInput> = {}) =>
    checkSegmentDuration({
      index: 1,
      expectedStart: 6,
      expectedDuration: 6,
      segmentCount: 5,
      reportedStart: 6,
      reportedEnd: 12,
      fps: 25,
      tier: "copy",
      isHeadFirstSegment: false,
      ...over,
    });

  it("accepts a segment whose absolute start and end match the table", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("accepts a head's own first segment, whose reported start is 0 rather than a timestamp", () => {
    // Measured against real ffmpeg: a head restarted at segment 1 prints
    // "0.000000,12.000000" -- start is the muxer's initial value, end is
    // absolute. end - start reads 12s; end - table[1].start reads 6s.
    expect(check({ isHeadFirstSegment: true, reportedStart: 0 })).toEqual({ ok: true });
  });

  it("accepts head-relative times, the other reading of the same line", () => {
    expect(check({ reportedStart: 0, reportedEnd: 6, isHeadFirstSegment: true })).toEqual({ ok: true });
  });

  it("rejects a double-length segment -- the missed cut this exists to catch", () => {
    const verdict = check({ reportedEnd: 18 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reportedDuration).toBeCloseTo(12, 6);
    expect(verdict.expectedDuration).toBeCloseTo(6, 6);
  });

  it("rejects a double-length FIRST segment too, under either reading", () => {
    // end = table[2]'s end: neither end - 0 (18) nor end - table[1].start
    // (12) is within tolerance of 6.
    expect(check({ isHeadFirstSegment: true, reportedStart: 0, reportedEnd: 18 }).ok).toBe(false);
  });

  it("tolerates a frame or two of drift", () => {
    expect(check({ reportedEnd: 12.2 })).toEqual({ ok: true });
    expect(check({ reportedEnd: 11.8 })).toEqual({ ok: true });
    expect(check({ reportedEnd: 12.6 }).ok).toBe(false);
  });

  it("lets a transcoded head's first segment run short, where its first frame is late", () => {
    expect(check({ tier: "transcode", isHeadFirstSegment: true, reportedStart: 0, reportedEnd: 11.7 })).toEqual({
      ok: true,
    });
  });

  it("never checks the last segment, whose length is whatever the file has left", () => {
    // The probed duration and the container's own streams routinely
    // disagree by more than a tolerance here, and a missed cut is
    // impossible at the end -- there is nothing after it to renumber.
    expect(check({ index: 4, expectedStart: 24, expectedDuration: 6, reportedStart: 24, reportedEnd: 29 })).toEqual({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Trimming played segments
// ---------------------------------------------------------------------------

describe("trimBytesNeeded", () => {
  const GiB = 1024 ** 3;

  it("asks for nothing when the cache is inside its budget and the disk is roomy", () => {
    expect(trimBytesNeeded(100, 200, 50 * GiB)).toBe(0);
    expect(trimBytesNeeded(200, 200, 50 * GiB)).toBe(0);
  });

  it("asks for the overage plus the hysteresis overshoot when over budget", () => {
    // 300 held, 200 allowed: back to 180 rather than exactly 200, so the
    // next tick has nothing to do.
    expect(trimBytesNeeded(300, 200, 50 * GiB)).toBe(300 - 200 * (1 - TRIM_HYSTERESIS));
  });

  it("trims on low free disk even when the byte budget is satisfied", () => {
    // The budget is meaningless for a live stream -- one pinned remux can
    // exceed it on its own -- so free disk is the other trigger.
    const free = 2 * GiB;
    expect(TRIM_FREE_DISK_LOW_WATER_BYTES).toBe(3 * MIN_FREE_DISK_BYTES);
    expect(trimBytesNeeded(100, 10 * GiB, free)).toBe(
      Math.ceil(TRIM_FREE_DISK_LOW_WATER_BYTES * (1 + TRIM_HYSTERESIS) - free),
    );
  });

  it("takes whichever pressure demands more", () => {
    expect(trimBytesNeeded(300, 200, 1 * GiB)).toBeGreaterThan(300);
  });

  it("does nothing on a platform that won't report free space", () => {
    // statfs failing is not evidence of a full disk; the budget still applies.
    expect(trimBytesNeeded(100, 200, null)).toBe(0);
    expect(trimBytesNeeded(300, 200, null)).toBe(300 - 200 * (1 - TRIM_HYSTERESIS));
  });
});

describe("selectSegmentsToTrim", () => {
  const GiB = 1024 ** 3;
  const ROOMY_DISK = 50 * GiB;
  /** 60 cached segments of 10 bytes, one viewer sitting on segment 40. */
  const stream = (over: Partial<TrimCandidateStream> = {}): TrimCandidateStream => ({
    key: "film-510-original-a1",
    segments: Array.from({ length: 60 }, (_, index) => ({ index, bytes: 10 })),
    playheads: [40],
    recentIndices: [],
    ...over,
  });
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  it("trims nothing at all when there is no pressure", () => {
    // The property V4_PLAN.md is proud of: a small title caches whole and
    // replays with no ffmpeg. Trimming it because someone watched it would
    // throw that away for nothing.
    expect(
      selectSegmentsToTrim({ streams: [stream()], totalBytes: 600, limitBytes: 10_000, freeBytes: ROOMY_DISK }),
    ).toEqual([]);
  });

  it("trims oldest index first, and only as far as the pressure demands", () => {
    // 600 held, 500 allowed -> 150 bytes to free -> 15 segments.
    const [trim] = selectSegmentsToTrim({
      streams: [stream()],
      totalBytes: 600,
      limitBytes: 500,
      freeBytes: ROOMY_DISK,
    });
    expect(trim.key).toBe("film-510-original-a1");
    expect(trim.indices).toEqual(range(0, 15));
    expect(trim.bytes).toBe(150);
  });

  it("leaves the hysteresis overshoot, so the next pass has nothing to do", () => {
    const [trim] = selectSegmentsToTrim({
      streams: [stream()],
      totalBytes: 600,
      limitBytes: 500,
      freeBytes: ROOMY_DISK,
    });
    const after = stream({ segments: stream().segments.filter((s) => !trim.indices.includes(s.index)) });
    expect(
      selectSegmentsToTrim({ streams: [after], totalBytes: 600 - trim.bytes, limitBytes: 500, freeBytes: ROOMY_DISK }),
    ).toEqual([]);
  });

  it("never trims at or above the protected range, however hard the pressure", () => {
    // Everything from KEEP_BEHIND_SEGMENTS behind the viewer onward stays:
    // the rewind window, what the viewer is watching, and the head's
    // run-ahead (which the throttle, not this, bounds).
    const [trim] = selectSegmentsToTrim({ streams: [stream()], totalBytes: 600, limitBytes: 1, freeBytes: ROOMY_DISK });
    expect(trim.indices).toEqual(range(0, 40 - KEEP_BEHIND_SEGMENTS));
    expect(Math.max(...trim.indices)).toBeLessThan(40 - KEEP_BEHIND_SEGMENTS);
  });

  it("protects behind the furthest-back viewer when two are watching one file", () => {
    // Two viewers on one key at different positions: the one at 25 owns the
    // floor, so nothing the one at 40 has passed is taken from under them.
    const [trim] = selectSegmentsToTrim({
      streams: [stream({ playheads: [40, 25] })],
      totalBytes: 600,
      limitBytes: 1,
      freeBytes: ROOMY_DISK,
    });
    expect(trim.indices).toEqual(range(0, 25 - KEEP_BEHIND_SEGMENTS));
  });

  it("trims nothing from a stream with no live session", () => {
    // Nobody is watching, so there is no "behind the viewer" here at all --
    // whole-stream LRU eviction owns this case and takes the directory
    // entire, rather than leaving a gap-ridden one behind.
    expect(
      selectSegmentsToTrim({
        streams: [stream({ playheads: [] })],
        totalBytes: 600,
        limitBytes: 1,
        freeBytes: ROOMY_DISK,
      }),
    ).toEqual([]);
  });

  it("skips a segment that was just requested, whatever its index", () => {
    // It may be mid-response: the engine has handed the route a path and
    // the route is about to open it.
    const [trim] = selectSegmentsToTrim({
      streams: [stream({ recentIndices: [3, 7, 45] })],
      totalBytes: 600,
      limitBytes: 1,
      freeBytes: ROOMY_DISK,
    });
    expect(trim.indices).not.toContain(3);
    expect(trim.indices).not.toContain(7);
    expect(trim.indices).toEqual(range(0, 20).filter((i) => i !== 3 && i !== 7));
  });

  it("takes from the largest live stream first", () => {
    const big = stream({ key: "film-510-original-a1" });
    const small = stream({ key: "film-7-remote-a1", segments: big.segments.map((s) => ({ ...s, bytes: 1 })) });
    const trims = selectSegmentsToTrim({
      streams: [small, big],
      totalBytes: 660,
      limitBytes: 600,
      freeBytes: ROOMY_DISK,
    });
    // 120 bytes to free, and the big stream alone covers it.
    expect(trims.map((t) => t.key)).toEqual(["film-510-original-a1"]);
    expect(trims[0].indices).toEqual(range(0, 12));
  });

  it("moves on to the next stream when the largest cannot free enough", () => {
    const big = stream({ key: "film-510-original-a1" });
    const other = stream({ key: "film-7-remote-a1" });
    const trims = selectSegmentsToTrim({
      streams: [big, other],
      totalBytes: 1200,
      limitBytes: 1,
      freeBytes: ROOMY_DISK,
    });
    expect(trims.map((t) => t.key)).toEqual(["film-510-original-a1", "film-7-remote-a1"]);
    for (const trim of trims) expect(trim.indices).toEqual(range(0, 20));
  });

  it("trims on low free disk even when the cache is inside its byte budget", () => {
    const [trim] = selectSegmentsToTrim({
      streams: [stream()],
      totalBytes: 600,
      limitBytes: 10 * GiB,
      freeBytes: 2 * GiB,
    });
    expect(trim.indices).toEqual(range(0, 20));
  });
});
