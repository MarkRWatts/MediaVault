import { describe, expect, it } from "vitest";
import { decidePendingSeek, formatClock, timeRangesToArray, writtenEnd } from "./pending-seek";

describe("decidePendingSeek", () => {
  it("seeks straight away when the target is inside what's been written (native live playlist: duration Infinity)", () => {
    expect(decidePendingSeek(600, [{ start: 0, end: 900 }], Infinity, false)).toEqual({ action: "seek", position: 600 });
  });

  it("waits when the target is past the written end, reporting how far is ready", () => {
    expect(decidePendingSeek(1800, [{ start: 0, end: 42 }], Infinity, false)).toEqual({ action: "wait", readyUpTo: 42 });
  });

  it("is not ready before the element reports any seekable media", () => {
    expect(decidePendingSeek(30, [], Infinity, false)).toEqual({ action: "not-ready" });
    expect(decidePendingSeek(30, [], NaN, true)).toEqual({ action: "not-ready" });
  });

  it("seeks to 0 for a fresh play of an in-progress playlist rather than starting at the live edge", () => {
    expect(decidePendingSeek(0, [{ start: 0, end: 6.4 }], Infinity, false)).toEqual({ action: "seek", position: 0 });
  });

  it("falls back to a finite duration when there's no seekable range yet (direct play / VOD)", () => {
    expect(decidePendingSeek(100, [], 7200, true)).toEqual({ action: "seek", position: 100 });
  });

  it("drops a target at or past a final duration instead of holding forever", () => {
    expect(decidePendingSeek(7200, [{ start: 0, end: 7200 }], 7200, true)).toEqual({ action: "drop" });
    expect(decidePendingSeek(9000, [], 7200, true)).toEqual({ action: "drop" });
  });

  it("waits, not drops, past a finite duration that is still growing (hls.js while preparing)", () => {
    expect(decidePendingSeek(1800, [{ start: 0, end: 42 }], 42, false)).toEqual({ action: "wait", readyUpTo: 42 });
  });

  it("uses the last seekable range on a multi-range element", () => {
    expect(writtenEnd([{ start: 0, end: 10 }, { start: 20, end: 30 }], Infinity)).toBe(30);
  });
});

describe("timeRangesToArray", () => {
  it("copies every range out of a TimeRanges-like object", () => {
    const ranges = { length: 2, start: (i: number) => [0, 20][i], end: (i: number) => [10, 30][i] };
    expect(timeRangesToArray(ranges)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });
});

describe("formatClock", () => {
  it("formats minutes and hours", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
  });
});
