import { describe, expect, it } from "vitest";
import { fixedSegmentTable, segmentTableFromKeyframes } from "./keyframes";

describe("segmentTableFromKeyframes", () => {
  it("cuts at the first keyframe >= 6s after the previous cut", () => {
    // After the cut at 6.5, the next cut needs a keyframe >= 12.5 — 8 and
    // 12.2 are both too soon, so the segment runs long until 18.
    const table = segmentTableFromKeyframes([0, 2, 4, 6.5, 8, 12.2, 18, 24], 30, 6);
    expect(table).toEqual([
      { index: 0, start: 0, duration: 6.5 },
      { index: 1, start: 6.5, duration: 11.5 },
      { index: 2, start: 18, duration: 6 },
      { index: 3, start: 24, duration: 6 },
    ]);
  });

  it("sparse keyframes produce long segments rather than cutting early", () => {
    const table = segmentTableFromKeyframes([0, 30, 60, 90], 100, 6);
    expect(table).toEqual([
      { index: 0, start: 0, duration: 30 },
      { index: 1, start: 30, duration: 30 },
      { index: 2, start: 60, duration: 30 },
      { index: 3, start: 90, duration: 10 },
    ]);
  });

  it("a keyframe exactly on the target boundary cuts there (>=, not >)", () => {
    const table = segmentTableFromKeyframes([0, 6, 12], 18, 6);
    expect(table).toEqual([
      { index: 0, start: 0, duration: 6 },
      { index: 1, start: 6, duration: 6 },
      { index: 2, start: 12, duration: 6 },
    ]);
  });

  it("duration shorter than one segment yields a single segment covering it all", () => {
    const table = segmentTableFromKeyframes([0, 1, 2], 3, 6);
    expect(table).toEqual([{ index: 0, start: 0, duration: 3 }]);
  });

  it("an empty keyframe list still yields one full-duration segment", () => {
    const table = segmentTableFromKeyframes([], 42, 6);
    expect(table).toEqual([{ index: 0, start: 0, duration: 42 }]);
  });

  it("ignores keyframes at or before the running cut, including duplicates", () => {
    const table = segmentTableFromKeyframes([0, 0, 3, 6, 6, 6, 20], 20, 6);
    expect(table).toEqual([
      { index: 0, start: 0, duration: 6 },
      { index: 1, start: 6, duration: 14 },
    ]);
  });

  it("drops keyframes at or beyond durationSecs", () => {
    const table = segmentTableFromKeyframes([0, 10, 15], 10, 6);
    expect(table).toEqual([{ index: 0, start: 0, duration: 10 }]);
  });

  it("returns no segments for a non-positive duration", () => {
    expect(segmentTableFromKeyframes([0, 6], 0, 6)).toEqual([]);
    expect(segmentTableFromKeyframes([0, 6], -5, 6)).toEqual([]);
  });

  it("de-duplicates and sorts an unsorted keyframe list", () => {
    const table = segmentTableFromKeyframes([12, 0, 6, 6, 0], 18, 6);
    expect(table).toEqual([
      { index: 0, start: 0, duration: 6 },
      { index: 1, start: 6, duration: 6 },
      { index: 2, start: 12, duration: 6 },
    ]);
  });
});

describe("fixedSegmentTable", () => {
  it("cuts at fixed boundaries with the remainder in the last segment", () => {
    expect(fixedSegmentTable(20, 6)).toEqual([
      { index: 0, start: 0, duration: 6 },
      { index: 1, start: 6, duration: 6 },
      { index: 2, start: 12, duration: 6 },
      { index: 3, start: 18, duration: 2 },
    ]);
  });

  it("an exact multiple of targetSecs has no short trailing segment", () => {
    expect(fixedSegmentTable(18, 6)).toEqual([
      { index: 0, start: 0, duration: 6 },
      { index: 1, start: 6, duration: 6 },
      { index: 2, start: 12, duration: 6 },
    ]);
  });

  it("duration shorter than one segment yields a single short segment", () => {
    expect(fixedSegmentTable(3, 6)).toEqual([{ index: 0, start: 0, duration: 3 }]);
  });

  it("returns no segments for a non-positive duration", () => {
    expect(fixedSegmentTable(0, 6)).toEqual([]);
    expect(fixedSegmentTable(-1, 6)).toEqual([]);
  });
});
