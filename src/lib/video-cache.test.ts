import { describe, expect, it, afterEach } from "vitest";
import { selectEntriesToEvict, maxCacheBytes, type CacheEntry } from "./video-cache";

describe("selectEntriesToEvict", () => {
  it("evicts nothing when under budget", () => {
    const entries: CacheEntry[] = [
      { path: "/a.mp4", size: 100, mtimeMs: 1 },
      { path: "/b.mp4", size: 100, mtimeMs: 2 },
    ];
    expect(selectEntriesToEvict(entries, 1000)).toEqual([]);
  });

  it("evicts the oldest-played entries first, stopping as soon as it's back under budget", () => {
    const entries: CacheEntry[] = [
      { path: "/newest.mp4", size: 50, mtimeMs: 300 },
      { path: "/oldest.mp4", size: 50, mtimeMs: 100 },
      { path: "/middle.mp4", size: 50, mtimeMs: 200 },
    ];
    // total 150, budget 100 -- must drop exactly one, the oldest.
    expect(selectEntriesToEvict(entries, 100)).toEqual(["/oldest.mp4"]);
  });

  it("evicts as many as needed, in age order, when one isn't enough", () => {
    const entries: CacheEntry[] = [
      { path: "/newest.mp4", size: 40, mtimeMs: 300 },
      { path: "/oldest.mp4", size: 40, mtimeMs: 100 },
      { path: "/middle.mp4", size: 40, mtimeMs: 200 },
    ];
    // total 120, budget 50 -- must drop oldest then middle to get under.
    expect(selectEntriesToEvict(entries, 50)).toEqual(["/oldest.mp4", "/middle.mp4"]);
  });

  it("evicts everything if even one entry alone exceeds budget", () => {
    const entries: CacheEntry[] = [{ path: "/only.mp4", size: 200, mtimeMs: 1 }];
    expect(selectEntriesToEvict(entries, 100)).toEqual(["/only.mp4"]);
  });
});

describe("maxCacheBytes", () => {
  const ORIGINAL = process.env.VIDEO_CACHE_MAX_BYTES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.VIDEO_CACHE_MAX_BYTES;
    else process.env.VIDEO_CACHE_MAX_BYTES = ORIGINAL;
  });

  it("defaults to 10 GiB when unset", () => {
    delete process.env.VIDEO_CACHE_MAX_BYTES;
    expect(maxCacheBytes()).toBe(10 * 1024 ** 3);
  });

  it("uses the env override when it's a valid positive number", () => {
    process.env.VIDEO_CACHE_MAX_BYTES = "5000";
    expect(maxCacheBytes()).toBe(5000);
  });

  it("falls back to the default for garbage input", () => {
    process.env.VIDEO_CACHE_MAX_BYTES = "not-a-number";
    expect(maxCacheBytes()).toBe(10 * 1024 ** 3);
  });

  it("falls back to the default for a zero or negative override", () => {
    process.env.VIDEO_CACHE_MAX_BYTES = "-1";
    expect(maxCacheBytes()).toBe(10 * 1024 ** 3);
  });
});
