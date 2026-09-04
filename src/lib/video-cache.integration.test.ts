// Drives the real prepare orchestrator end to end -- ffmpeg, the HLS
// output, the cache directory -- against a synthetic MKV, with a real temp
// SQLite database (src/lib/test-temp-db.ts) for the Version row. Pins the
// behaviour the unit tests can only describe:
//
//   - a first play produces an HLS entry (playlist, init segment, media
//     segments, ENDLIST, `.complete`), and a later play finds it ready;
//   - the remote variant is its own entry alongside the original;
//   - an incomplete entry nobody is writing is an orphan: status says idle
//     and the directory is gone, rather than "preparing" forever;
//   - making room evicts least-recently-played finished entries, counting
//     the incoming one, and never the entry that was just produced;
//   - segment names are whitelisted and a direct-play source is refused by
//     the playlist path.
//
// Skipped where ffmpeg isn't on PATH (the Docker runner image and the
// GitHub Ubuntu image both have it; a bare laptop might not).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let cache: typeof import("@/lib/video-cache");
let root: string;
let versionId: number;

async function waitForReady(kind: "film", id: number, variant: "original" | "remote", timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await cache.getVideoStatus(kind, id, variant);
    if (status.state === "ready") return status;
    if (status.state === "error") throw new Error(status.message);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for ready");
}

describe.skipIf(!hasFfmpeg)("video-cache prepare pipeline (real ffmpeg, HLS)", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;

    root = await mkdtemp(path.join(tmpdir(), "mv-video-cache-"));
    const movies = path.join(root, "movies");
    await mkdir(movies);
    process.env.MOVIES_PATH = movies;
    process.env.VIDEO_CACHE_DIR = path.join(root, "cache");
    delete process.env.VIDEO_CACHE_MAX_BYTES;

    // H.264 in MKV with AC-3: a "prepare" plan (container needs remuxing,
    // both streams copied), the most common real case in this library.
    // 14 seconds so the 6s segmenting yields three segments.
    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=14:size=160x120:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=14",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "20",
        "-c:a", "ac3", "-shortest",
        path.join(movies, "Test Film (2020).mkv"),
      ],
      { stdio: "pipe" },
    );

    const film = await testPrisma.film.create({
      data: { title: "Test Film", sortTitle: "test film", year: 2020, owned: true },
    });
    const version = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Test Film (2020).mkv",
        fileName: "Test Film (2020).mkv",
        format: "BLURAY",
        videoCodec: "h264",
        container: "mkv",
        durationSecs: 14,
        audioTracks: { create: [{ streamIdx: 1, codec: "ac3", channels: 2 }] },
      },
    });
    versionId = version.id;

    cache = await import("@/lib/video-cache");
  });

  afterAll(async () => {
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  it("produces an HLS entry on first play and serves it as ready afterwards", async () => {
    const first = await cache.resolveHlsPlaylist("film", versionId, "original");
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    // Whether the first response caught the job mid-write or after it
    // finished depends on how fast this box remuxes 14 seconds; both are a
    // successful first play. Either way the playlist already has a segment.
    expect(await readFile(first.absPath, "utf8")).toContain("#EXTINF");

    await waitForReady("film", versionId, "original");
    const dir = path.join(process.env.VIDEO_CACHE_DIR!, `film-${versionId}`);
    const names = (await readdir(dir)).sort();
    expect(names).toContain(".complete");
    expect(names).toContain("index.m3u8");
    expect(names).toContain("init.mp4");
    expect(names.filter((n) => /^seg_\d{5}\.m4s$/.test(n)).length).toBeGreaterThanOrEqual(2);
    const playlist = await readFile(path.join(dir, "index.m3u8"), "utf8");
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);

    const again = await cache.resolveHlsPlaylist("film", versionId, "original");
    expect(again).toMatchObject({ kind: "ready", complete: true });

    const init = await cache.resolveHlsFile("film", versionId, "original", "init.mp4");
    expect(init?.contentType).toBe("video/mp4");
    const seg = await cache.resolveHlsFile("film", versionId, "original", "seg_00000.m4s");
    expect(seg?.contentType).toBe("video/iso.segment");
    expect(await cache.resolveHlsFile("film", versionId, "original", "../index.m3u8")).toBeNull();
    expect(await cache.resolveHlsFile("film", versionId, "original", "seg_99999.m4s")).toBeNull();
  });

  it("prepares the remote variant as a separate entry", async () => {
    const resolved = await cache.resolveHlsPlaylist("film", versionId, "remote");
    expect(resolved.kind).toBe("ready");
    await waitForReady("film", versionId, "remote");
    const names = (await readdir(process.env.VIDEO_CACHE_DIR!)).sort();
    expect(names).toEqual([`film-${versionId}`, `film-${versionId}-remote`]);
    expect(await cache.getVideoStatus("film", versionId, "original")).toEqual({ state: "ready" });
  });

  it("refuses the playlist for a direct-play source and points at /stream", async () => {
    // An MP4/H.264/AC-3 version is direct-playable: the playlist route must
    // say so rather than pointlessly remux it.
    const film = await testPrisma.film.create({ data: { title: "Direct", sortTitle: "direct", owned: true } });
    // Version.filePath is unique, so give it its own file; the bytes are the
    // MKV's, but only the recorded codec/container drive the plan and only
    // existence is checked for direct play.
    await copyFile(path.join(process.env.MOVIES_PATH!, "Test Film (2020).mkv"), path.join(process.env.MOVIES_PATH!, "Direct (2020).mp4"));
    const direct = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Direct (2020).mp4",
        fileName: "Direct (2020).mp4",
        format: "BLURAY",
        videoCodec: "h264",
        container: "mp4",
        audioTracks: { create: [{ streamIdx: 1, codec: "ac3", channels: 2 }] },
      },
    });
    expect(await cache.resolveHlsPlaylist("film", direct.id, "original")).toEqual({ kind: "direct" });
    expect(await cache.getVideoStatus("film", direct.id, "original")).toEqual({ state: "direct" });
    expect((await cache.resolveVideoStream("film", direct.id)).kind).toBe("complete");
    // …but a remote rendition of it is a prepare like any other.
    expect((await cache.resolveVideoStream("film", versionId)).kind).toBe("needs-prepare");
  });

  it("treats an incomplete entry nobody is writing as an orphan, not as 'preparing'", async () => {
    const dir = path.join(process.env.VIDEO_CACHE_DIR!, `film-${versionId}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await writeFile(path.join(dir, "index.m3u8"), "#EXTM3U\n#EXTINF:6,\nseg_00000.m4s\n");

    expect(await cache.getVideoStatus("film", versionId, "original")).toEqual({ state: "idle" });
    expect(await readdir(process.env.VIDEO_CACHE_DIR!)).not.toContain(`film-${versionId}`);
  });

  it("makes room for the incoming entry by evicting least-recently-played finished entries, keeping the new one", async () => {
    const cacheRoot = process.env.VIDEO_CACHE_DIR!;
    for (const name of await readdir(cacheRoot)) await rm(path.join(cacheRoot, name), { recursive: true, force: true });

    // Two finished entries that together already exceed the cap; the older
    // one must go to make room, the newer one must survive.
    const kb = 1024;
    for (const [name, ageHours] of [["film-9001", 2], ["film-9002", 0]] as const) {
      const dir = path.join(cacheRoot, name);
      await mkdir(dir);
      await writeFile(path.join(dir, "seg_00000.m4s"), Buffer.alloc(300 * kb));
      await writeFile(path.join(dir, ".complete"), "");
      const when = new Date(Date.now() - ageHours * 3600 * 1000);
      await utimes(dir, when, when);
    }
    // Cap: both finished entries plus the incoming one don't fit, but one
    // finished entry plus the incoming one does -- so exactly the older
    // finished entry must go.
    const sourceSize = (await stat(path.join(process.env.MOVIES_PATH!, "Test Film (2020).mkv"))).size;
    process.env.VIDEO_CACHE_MAX_BYTES = String(300 * kb + sourceSize + 50 * kb);

    try {
      const resolved = await cache.resolveHlsPlaylist("film", versionId, "original");
      expect(resolved.kind).toBe("ready");
      await waitForReady("film", versionId, "original");

      const names = (await readdir(cacheRoot)).sort();
      expect(names).toEqual([`film-${versionId}`, "film-9002"]);
    } finally {
      delete process.env.VIDEO_CACHE_MAX_BYTES;
    }
  });
});
