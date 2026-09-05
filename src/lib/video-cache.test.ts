import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectEntriesToEvict, maxCacheBytes, sweepOrphanedPartialsIn, type CacheEntry } from "./video-cache";

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

  // The disk-filling bug: an in-flight .partial can be tens of GB and used
  // to be invisible to the budget. It must count toward the total (so
  // *other* files get evicted to make room for it) without ever being a
  // candidate itself (deleting a file ffmpeg is writing helps nobody).
  it("counts pinned entries toward the total but never evicts them", () => {
    const entries: CacheEntry[] = [
      { path: "/done-old.mp4", size: 40, mtimeMs: 100 },
      { path: "/done-new.mp4", size: 40, mtimeMs: 200 },
      { path: "/live.mp4.partial", size: 60, mtimeMs: 300, pinned: true },
    ];
    // total 140, budget 100: dropping the oldest finished file gets to 100.
    expect(selectEntriesToEvict(entries, 100)).toEqual(["/done-old.mp4"]);
  });

  it("stops short of the budget rather than evict a pinned entry that alone exceeds it", () => {
    const entries: CacheEntry[] = [
      { path: "/done.mp4", size: 10, mtimeMs: 100 },
      { path: "/huge-remux.mp4", size: 500, mtimeMs: 200, pinned: true },
    ];
    // Every unpinned file goes; the pinned one stays even though 500 > 100.
    expect(selectEntriesToEvict(entries, 100)).toEqual(["/done.mp4"]);
  });

  it("treats an incoming file as the newest, pinned entry when making room", () => {
    const entries: CacheEntry[] = [
      { path: "/a.mp4", size: 30, mtimeMs: 100 },
      { path: "/b.mp4", size: 30, mtimeMs: 200 },
      { path: "/c.mp4", size: 30, mtimeMs: 300 },
      { path: "<incoming>", size: 50, mtimeMs: Number.POSITIVE_INFINITY, pinned: true },
    ];
    // 90 present + 50 incoming = 140 against a budget of 100: evict a and b.
    expect(selectEntriesToEvict(entries, 100)).toEqual(["/a.mp4", "/b.mp4"]);
  });
});

describe("sweepOrphanedPartialsIn", () => {
  it("removes partials with no live job and leaves everything else alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mv-cache-"));
    await writeFile(path.join(dir, "film-1.mp4"), "done");
    await writeFile(path.join(dir, "film-2.mp4.partial"), "orphan");
    await writeFile(path.join(dir, "scene-3.mp4.partial"), "live");
    await writeFile(path.join(dir, "notes.txt"), "unrelated");

    const removed = await sweepOrphanedPartialsIn(dir, (key) => key === "scene-3");

    expect(removed).toEqual([path.join(dir, "film-2.mp4.partial")]);
    expect((await readdir(dir)).sort()).toEqual(["film-1.mp4", "notes.txt", "scene-3.mp4.partial"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("is a no-op on a missing directory", async () => {
    expect(await sweepOrphanedPartialsIn("/definitely/not/here", () => false)).toEqual([]);
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
