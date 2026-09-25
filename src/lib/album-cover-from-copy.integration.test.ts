// An album's own cover following the copy its files came from
// (copyForAlbumCover / followOwnedCopyCover), against a real database and
// real cover files: a CD rip takes its CD's cover, file and all, and its
// version (updatedAt) moves so the apps fetch it; an MP3-only album and one
// whose art came from its own files are left alone.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let root: string;
let covers: string;
let followOwnedCopyCover: typeof import("@/lib/discogs").followOwnedCopyCover;

async function albumWith(opts: { title: string; codec: string; coverSource: string; digitalSource?: string }) {
  const artist = await testPrisma.artist.create({ data: { name: `${opts.title} Artist`, sortName: opts.title } });
  const album = await testPrisma.album.create({
    data: {
      artistId: artist.id,
      title: opts.title,
      sortTitle: opts.title,
      coverPath: "placeholder.jpg",
      coverSource: opts.coverSource,
      digitalSource: opts.digitalSource ?? null,
    },
  });
  await testPrisma.album.update({ where: { id: album.id }, data: { coverPath: `${album.id}.jpg` } });
  await writeFile(path.join(covers, `${album.id}.jpg`), "master art");
  await testPrisma.track.create({
    data: { albumId: album.id, title: "One", filePath: `${opts.title}/01.m4a`, fileName: "01.m4a", codec: opts.codec },
  });
  await testPrisma.physicalCopy.create({
    data: { albumId: album.id, medium: "CD", format: "CD", discogsReleaseId: 5824, coverPath: `${album.id}-cd.jpg`, coverSource: "discogs" },
  });
  await writeFile(path.join(covers, `${album.id}-cd.jpg`), "the CD I own");
  return testPrisma.album.findUniqueOrThrow({ where: { id: album.id } });
}

describe("an album's cover follows the copy its files came from", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;
    root = await mkdtemp(path.join(tmpdir(), "mv-cover-copy-"));
    process.env.POSTER_CACHE_DIR = root;
    covers = path.join(root, "covers");
    await mkdir(covers);
    ({ followOwnedCopyCover } = await import("@/lib/discogs"));
  });

  afterAll(async () => {
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  it("gives an ALAC rip its CD's cover, and a new version", async () => {
    const before = await albumWith({ title: "Pieces", codec: "alac", coverSource: "discogs" });
    await new Promise((r) => setTimeout(r, 5));
    expect(await followOwnedCopyCover(before.id)).toBe(true);
    const after = await testPrisma.album.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.coverSource).toBe("physical");
    expect(after.coverPath).toBe(`${before.id}.jpg`);
    expect(await readFile(path.join(covers, `${before.id}.jpg`), "utf8")).toBe("the CD I own");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("leaves an MP3-only album and art from the files alone", async () => {
    for (const opts of [
      { title: "Mp3s", codec: "mp3", coverSource: "discogs" },
      { title: "Embedded", codec: "alac", coverSource: "embedded" },
    ]) {
      const album = await albumWith(opts);
      expect(await followOwnedCopyCover(album.id)).toBe(false);
      expect((await testPrisma.album.findUniqueOrThrow({ where: { id: album.id } })).coverSource).toBe(opts.coverSource);
      expect(await readFile(path.join(covers, `${album.id}.jpg`), "utf8")).toBe("master art");
    }
  });
});
