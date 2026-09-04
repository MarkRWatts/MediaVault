// Drives the real prepare orchestrator end to end -- ffmpeg, the tailing
// reader, the cache directory -- against a synthetic two-second MKV, with a
// real temp SQLite database (src/lib/test-temp-db.ts) for the Version row.
// Pins the housekeeping behaviour that the unit tests can only describe:
//
//   - a first play remuxes while streaming, lands a .mp4, leaves no .partial;
//   - a .partial with no job writing it is an orphan: status says idle and
//     the file is gone, rather than "preparing" forever;
//   - making room evicts least-recently-played finished files, counting the
//     incoming file, and never the file that was just produced.
//
// Skipped where ffmpeg isn't on PATH (the Docker runner image and the
// GitHub Ubuntu image both have it; a bare laptop might not).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import { createTailingStream } from "@/lib/tailing-stream";
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

/** Read a resolution to the end the way the stream route would. A tiny
 *  synthetic clip can finish remuxing inside resolveVideoStream's first
 *  200ms poll, in which case it legitimately resolves as "complete" rather
 *  than "tailing" -- both are a successful first play. */
async function playThrough(resolved: Awaited<ReturnType<typeof cache.resolveVideoStream>>): Promise<number> {
  if (resolved.kind === "complete") return (await stat(resolved.absPath)).size;
  if (resolved.kind !== "tailing") throw new Error(`unexpected resolution: ${JSON.stringify(resolved)}`);
  let bytes = 0;
  const { absPath, isDone, hasErrored } = resolved;
  for await (const chunk of createTailingStream(absPath, { isDone, hasErrored, pollIntervalMs: 50 })) {
    bytes += (chunk as Buffer).length;
  }
  // The job's own rename/eviction pass runs after the last byte; wait for
  // it so the directory assertions below see the settled state.
  while (!(await isDone())) await new Promise((r) => setTimeout(r, 25));
  return bytes;
}

describe.skipIf(!hasFfmpeg)("video-cache prepare pipeline (real ffmpeg)", () => {
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
    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
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

  it("remuxes on first play while streaming, then serves the cached file", async () => {
    const resolved = await cache.resolveVideoStream("film", versionId);
    expect(["tailing", "complete"]).toContain(resolved.kind);
    const bytes = await playThrough(resolved);
    expect(bytes).toBeGreaterThan(1000);

    const names = (await readdir(process.env.VIDEO_CACHE_DIR!)).sort();
    expect(names).toEqual([`film-${versionId}.mp4`]);
    expect(await cache.getVideoStatus("film", versionId)).toEqual({ state: "ready" });

    const again = await cache.resolveVideoStream("film", versionId);
    expect(again.kind).toBe("complete");
    // A real fragmented MP4: starts with an ftyp box.
    const head = (await readFile(path.join(process.env.VIDEO_CACHE_DIR!, `film-${versionId}.mp4`))).subarray(4, 8);
    expect(head.toString()).toBe("ftyp");
  });

  it("treats a .partial nobody is writing as an orphan, not as 'preparing'", async () => {
    const dir = process.env.VIDEO_CACHE_DIR!;
    await rm(path.join(dir, `film-${versionId}.mp4`), { force: true });
    const orphan = path.join(dir, `film-${versionId}.mp4.partial`);
    await writeFile(orphan, "left behind by a killed process");

    expect(await cache.getVideoStatus("film", versionId)).toEqual({ state: "idle" });
    expect(await readdir(dir)).not.toContain(`film-${versionId}.mp4.partial`);
  });

  it("makes room for the incoming file by evicting least-recently-played finished files, keeping the new one", async () => {
    const dir = process.env.VIDEO_CACHE_DIR!;
    for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });

    // Two finished files that together already exceed the cap; the older one
    // must go to make room, the newer one must survive.
    const kb = 1024;
    await writeFile(path.join(dir, "film-9001.mp4"), Buffer.alloc(300 * kb));
    await writeFile(path.join(dir, "film-9002.mp4"), Buffer.alloc(300 * kb));
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(path.join(dir, "film-9001.mp4"), old, old);
    process.env.VIDEO_CACHE_MAX_BYTES = String(500 * kb);

    try {
      const resolved = await cache.resolveVideoStream("film", versionId);
      expect(["tailing", "complete"]).toContain(resolved.kind);
      await playThrough(resolved);

      const names = (await readdir(dir)).sort();
      expect(names).toEqual([`film-${versionId}.mp4`, "film-9002.mp4"]);
      const produced = await stat(path.join(dir, `film-${versionId}.mp4`));
      expect(produced.size).toBeGreaterThan(0);
    } finally {
      delete process.env.VIDEO_CACHE_MAX_BYTES;
    }
  });
});
