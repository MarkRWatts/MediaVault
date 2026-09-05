import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  selectEntriesToEvict,
  maxCacheBytes,
  sweepOrphanedEntriesIn,
  estimateOutputBytes,
  HLS_FILE_RE,
  type CacheEntry,
} from "./video-cache";

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

describe("sweepOrphanedEntriesIn", () => {
  it("removes incomplete entries with no live job, legacy files, and strays; keeps complete and live ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mv-cache-"));
    // A finished entry: keep.
    await mkdir(path.join(dir, "film-1"));
    await writeFile(path.join(dir, "film-1", ".complete"), "");
    await writeFile(path.join(dir, "film-1", "index.m3u8"), "#EXTM3U");
    // An in-progress entry nobody is writing: orphan, remove.
    await mkdir(path.join(dir, "film-2"));
    await writeFile(path.join(dir, "film-2", "index.m3u8"), "#EXTM3U");
    // An in-progress entry with a live job: keep.
    await mkdir(path.join(dir, "scene-3-remote"));
    await writeFile(path.join(dir, "scene-3-remote", "seg_00000.m4s"), "…");
    // The pre-HLS layout and a stray file: unknown to this layout, remove.
    await writeFile(path.join(dir, "film-4.mp4"), "legacy");
    await writeFile(path.join(dir, "film-5.mp4.partial"), "legacy");
    await writeFile(path.join(dir, "notes.txt"), "stray");

    const removed = await sweepOrphanedEntriesIn(dir, (key) => key === "scene-3-remote");

    expect(removed.map((p) => path.basename(p)).sort()).toEqual(["film-2", "film-4.mp4", "film-5.mp4.partial", "notes.txt"]);
    expect((await readdir(dir)).sort()).toEqual(["film-1", "scene-3-remote"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("is a no-op on a missing directory", async () => {
    expect(await sweepOrphanedEntriesIn("/definitely/not/here", () => false)).toEqual([]);
  });
});

describe("estimateOutputBytes", () => {
  it("bounds an original-variant output by the source size", () => {
    expect(estimateOutputBytes(40_000, 7200, "original")).toBe(40_000);
  });

  it("sizes a remote-variant output from duration at the encode ceiling, never above the source", () => {
    // 2h at ~3.128 Mbps × 1.2 margin ≈ 3.4 GB; far below a 40 GB source.
    const estimate = estimateOutputBytes(40 * 1024 ** 3, 7200, "remote");
    expect(estimate).toBeGreaterThan(3 * 1024 ** 3);
    expect(estimate).toBeLessThan(4 * 1024 ** 3);
    // A tiny source can't produce more than itself.
    expect(estimateOutputBytes(1000, 7200, "remote")).toBe(1000);
  });

  it("falls back to a quarter of the source when the duration is unknown", () => {
    expect(estimateOutputBytes(4000, null, "remote")).toBe(1000);
  });
});

describe("HLS_FILE_RE", () => {
  it("accepts only the init segment and zero-padded media segments", () => {
    expect(HLS_FILE_RE.test("init.mp4")).toBe(true);
    expect(HLS_FILE_RE.test("seg_00000.m4s")).toBe(true);
    expect(HLS_FILE_RE.test("seg_12345.m4s")).toBe(true);
    for (const bad of ["index.m3u8", "../init.mp4", "seg_1.m4s", "seg_00000.m4s/", ".complete", "seg_00000.mp4", "init.mp4\n"]) {
      expect(HLS_FILE_RE.test(bad)).toBe(false);
    }
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
