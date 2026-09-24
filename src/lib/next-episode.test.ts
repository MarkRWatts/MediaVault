// What the show page's one big button offers, against a REAL isolated SQLite
// database — same pattern as queries-film-shows.test.ts. The claims here
// ("a show with specials still starts at S01E01", "a half-watched episode
// wins over the one you skipped") are claims about what the query returns
// from real rows, which is exactly where the bug was.
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

const { getNextEpisodeFile, getShowEpisodeProgress } = await import("@/lib/film-user-state");

const VIEWER = "viewer-1";

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

let nextId = 0;

/** A show whose seasons are given as [seasonNumber, episodeCount]. Every file
 *  gets both a jellyfinId and a videoCodec so it counts as playable whichever
 *  engine the flag reports. */
async function seedShow(seasons: [number, number][]): Promise<number> {
  const id = ++nextId;
  const show = await testPrisma.show.create({
    data: { title: `Show ${id}`, sortTitle: `show ${id}`, folder: `Show ${id}` },
  });
  for (const [seasonNumber, episodeCount] of seasons) {
    const season = await testPrisma.showSeason.create({ data: { showId: show.id, seasonNumber } });
    for (let episodeNumber = 1; episodeNumber <= episodeCount; episodeNumber++) {
      const episode = await testPrisma.episode.create({
        data: { seasonId: season.id, episodeNumber, owned: true },
      });
      await testPrisma.episodeFile.create({
        data: {
          episodeId: episode.id,
          filePath: `show-${show.id}/s${seasonNumber}e${episodeNumber}.mkv`,
          fileName: `s${seasonNumber}e${episodeNumber}.mkv`,
          videoCodec: "h264",
          jellyfinId: `jf-${show.id}-${seasonNumber}-${episodeNumber}`,
        },
      });
    }
  }
  return show.id;
}

async function fileFor(showId: number, seasonNumber: number, episodeNumber: number): Promise<number> {
  const file = await testPrisma.episodeFile.findFirstOrThrow({
    where: {
      episode: { episodeNumber, season: { showId, seasonNumber } },
    },
  });
  return file.id;
}

/** `minutesAgo` backdates the sitting so "most recent" has something to
 *  compare; positionSecs 0 with completed true is how a finished episode
 *  looks once the player has stopped reporting. */
async function watch(
  showId: number,
  seasonNumber: number,
  episodeNumber: number,
  { positionSecs, completed, minutesAgo = 0 }: { positionSecs: number; completed: boolean; minutesAgo?: number },
) {
  const episodeFileId = await fileFor(showId, seasonNumber, episodeNumber);
  const row = await testPrisma.watchProgress.create({
    data: { userId: VIEWER, episodeFileId, positionSecs, completed },
  });
  await testPrisma.$executeRaw`UPDATE "WatchProgress" SET "updatedAt" = ${new Date(
    Date.now() - minutesAgo * 60_000,
  ).toISOString()} WHERE "id" = ${row.id}`;
}

describe("getNextEpisodeFile", () => {
  it("starts at S01E01 rather than a special", async () => {
    const showId = await seedShow([
      [0, 2],
      [1, 3],
    ]);
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S01E01", resume: false });
  });

  it("offers the same first episode to a signed-out viewer", async () => {
    const showId = await seedShow([
      [0, 1],
      [1, 2],
    ]);
    expect(await getNextEpisodeFile(null, showId)).toMatchObject({ label: "S01E01", resume: false });
  });

  it("carries on with a part-watched episode", async () => {
    const showId = await seedShow([[1, 3]]);
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 2, { positionSecs: 600, completed: false });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S01E02", resume: true });
  });

  it("prefers the most recent sitting over an episode skipped long ago", async () => {
    const showId = await seedShow([
      [1, 3],
      [2, 6],
    ]);
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    // S01E03 never started, S02E05 stopped half-way last night.
    await watch(showId, 2, 5, { positionSecs: 900, completed: false, minutesAgo: 10 });
    await watch(showId, 2, 4, { positionSecs: 700, completed: false, minutesAgo: 6000 });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({
      label: "S02E05",
      seasonNumber: 2,
      episodeNumber: 5,
      resume: true,
    });
  });

  it("treats a few seconds of playback as not started", async () => {
    const showId = await seedShow([[1, 2]]);
    await watch(showId, 1, 1, { positionSecs: 12, completed: false });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S01E01", resume: false });
  });

  it("moves on to the next unfinished episode", async () => {
    const showId = await seedShow([[1, 3]]);
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 2, { positionSecs: 1400, completed: true });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S01E03", resume: false });
  });

  it("offers an unwatched special once the run proper is done", async () => {
    const showId = await seedShow([
      [0, 1],
      [1, 2],
    ]);
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 2, { positionSecs: 1400, completed: true });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S00E01", resume: false });
  });

  it("restarts at the opening episode, not a special, once everything is watched", async () => {
    const showId = await seedShow([
      [0, 1],
      [1, 2],
    ]);
    await watch(showId, 0, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 2, { positionSecs: 1400, completed: true });
    expect(await getNextEpisodeFile(VIEWER, showId)).toMatchObject({ label: "S01E01", resume: false });
  });

  it("has nothing to offer for a show with no playable files", async () => {
    const showId = await seedShow([]);
    expect(await getNextEpisodeFile(VIEWER, showId)).toBeNull();
  });
});

describe("getShowEpisodeProgress", () => {
  it("lists this viewer's progress on this show's files only", async () => {
    const showId = await seedShow([[1, 3]]);
    const otherShowId = await seedShow([[1, 1]]);
    await watch(showId, 1, 1, { positionSecs: 1400, completed: true });
    await watch(showId, 1, 2, { positionSecs: 600, completed: false });
    await watch(otherShowId, 1, 1, { positionSecs: 600, completed: false });
    await testPrisma.watchProgress.create({
      data: { userId: "someone-else", episodeFileId: await fileFor(showId, 1, 3), positionSecs: 300 },
    });

    const rows = await getShowEpisodeProgress(VIEWER, showId);
    expect(rows.sort((a, b) => a.episodeFileId - b.episodeFileId)).toEqual([
      { episodeFileId: await fileFor(showId, 1, 1), positionSecs: 1400, durationSecs: null, completed: true },
      { episodeFileId: await fileFor(showId, 1, 2), positionSecs: 600, durationSecs: null, completed: false },
    ]);
  });
});
