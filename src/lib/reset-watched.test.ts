// "Reset watch status" (resetFilmWatched / resetShowWatched), against a REAL
// isolated SQLite database — same pattern as next-episode.test.ts. The
// claims are about which rows go: every version or episode file of the one
// title, for the one person, and nothing of anyone else's.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { resetFilmWatched, resetShowWatched } = await import("@/lib/film-user-state");

const VIEWER = "viewer-1";
const SOMEONE_ELSE = "viewer-2";

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

let nextId = 0;

/** A film with `versions` copies; returns its id and theirs. */
async function seedFilm(versions: number): Promise<{ filmId: number; versionIds: number[] }> {
  const id = ++nextId;
  const film = await testPrisma.film.create({ data: { title: `Film ${id}`, sortTitle: `film ${id}` } });
  const versionIds: number[] = [];
  for (let v = 1; v <= versions; v++) {
    const version = await testPrisma.version.create({
      data: { filmId: film.id, filePath: `film-${id}/v${v}.mp4`, fileName: `v${v}.mp4` },
    });
    versionIds.push(version.id);
  }
  return { filmId: film.id, versionIds };
}

/** A one-season show; returns its id and its episode files' ids. */
async function seedShow(episodes: number): Promise<{ showId: number; fileIds: number[] }> {
  const id = ++nextId;
  const show = await testPrisma.show.create({
    data: { title: `Show ${id}`, sortTitle: `show ${id}`, folder: `Show ${id}` },
  });
  const season = await testPrisma.showSeason.create({ data: { showId: show.id, seasonNumber: 1 } });
  const fileIds: number[] = [];
  for (let episodeNumber = 1; episodeNumber <= episodes; episodeNumber++) {
    const episode = await testPrisma.episode.create({ data: { seasonId: season.id, episodeNumber, owned: true } });
    const file = await testPrisma.episodeFile.create({
      data: { episodeId: episode.id, filePath: `show-${id}/e${episodeNumber}.mkv`, fileName: `e${episodeNumber}.mkv` },
    });
    fileIds.push(file.id);
  }
  return { showId: show.id, fileIds };
}

async function progressCount(where: object): Promise<number> {
  return testPrisma.watchProgress.count({ where });
}

describe("resetFilmWatched", () => {
  it("clears the person's progress on every version of the film, and only theirs", async () => {
    const { filmId, versionIds } = await seedFilm(2);
    const other = await seedFilm(1);
    await testPrisma.watchProgress.createMany({
      data: [
        { userId: VIEWER, versionId: versionIds[0], positionSecs: 600 },
        { userId: VIEWER, versionId: versionIds[1], positionSecs: 7000, completed: true },
        { userId: VIEWER, versionId: other.versionIds[0], positionSecs: 300 },
        { userId: SOMEONE_ELSE, versionId: versionIds[0], positionSecs: 900 },
      ],
    });

    expect(await resetFilmWatched(VIEWER, filmId)).toEqual({ cleared: 2 });
    expect(await progressCount({ userId: VIEWER, versionId: { in: versionIds } })).toBe(0);
    expect(await progressCount({ userId: VIEWER, versionId: other.versionIds[0] })).toBe(1);
    expect(await progressCount({ userId: SOMEONE_ELSE, versionId: versionIds[0] })).toBe(1);
  });

  it("answers cleared 0 for a film never watched", async () => {
    const { filmId } = await seedFilm(1);
    expect(await resetFilmWatched(VIEWER, filmId)).toEqual({ cleared: 0 });
  });

  it("refuses a non-integer id", async () => {
    await expect(resetFilmWatched(VIEWER, 1.5)).rejects.toThrow("invalid film id");
  });
});

describe("resetShowWatched", () => {
  it("clears the person's progress on every episode of the show, and only theirs", async () => {
    const { showId, fileIds } = await seedShow(3);
    const other = await seedShow(1);
    await testPrisma.watchProgress.createMany({
      data: [
        { userId: VIEWER, episodeFileId: fileIds[0], positionSecs: 2400, completed: true },
        { userId: VIEWER, episodeFileId: fileIds[1], positionSecs: 120 },
        { userId: VIEWER, episodeFileId: other.fileIds[0], positionSecs: 60 },
        { userId: SOMEONE_ELSE, episodeFileId: fileIds[0], positionSecs: 800 },
      ],
    });

    expect(await resetShowWatched(VIEWER, showId)).toEqual({ cleared: 2 });
    expect(await progressCount({ userId: VIEWER, episodeFileId: { in: fileIds } })).toBe(0);
    expect(await progressCount({ userId: VIEWER, episodeFileId: other.fileIds[0] })).toBe(1);
    expect(await progressCount({ userId: SOMEONE_ELSE, episodeFileId: fileIds[0] })).toBe(1);
  });
});
