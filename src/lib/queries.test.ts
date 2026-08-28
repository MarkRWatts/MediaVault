// Exercises getWatchStats() (HOUSEHOLDS_PLAN.md's "Watch history & stats",
// Phase 9) against a REAL, isolated SQLite database — same pattern as
// access.test.ts/require-member.test.ts — since the interesting part of this
// function (the watch-time calculation, the genre split, the most-watched
// dedup) is exactly the kind of thing that's easy to get subtly wrong and
// hard to trust from reading alone. A temp on-disk SQLite file is migrated
// with the real schema and wired in via vi.mock("@/lib/db", ...) so
// src/lib/queries.ts's own `import { prisma } from "@/lib/db"` resolves to
// this test's isolated instance instead of the dev database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { getWatchStats } = await import("@/lib/queries");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

let nextFilmId = 1;
let nextVersionId = 1;

async function seedUser(id: string) {
  await testPrisma.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
  });
}

async function seedFilmWithVersion(opts: {
  title: string;
  genres?: string | null;
  durationSecs?: number | null;
}) {
  const filmId = nextFilmId++;
  const versionId = nextVersionId++;
  await testPrisma.film.create({
    data: {
      id: filmId,
      title: opts.title,
      sortTitle: opts.title.toLowerCase(),
      genres: opts.genres ?? null,
    },
  });
  await testPrisma.version.create({
    data: {
      id: versionId,
      filmId,
      filePath: `/movies/${opts.title}-${versionId}.mkv`,
      fileName: `${opts.title}-${versionId}.mkv`,
      durationSecs: opts.durationSecs ?? null,
    },
  });
  return { filmId, versionId };
}

async function seedProgress(opts: {
  userId: string;
  versionId: number;
  positionSecs: number;
  completed: boolean;
  playCount: number;
  updatedAt: Date;
}) {
  await testPrisma.watchProgress.create({
    data: {
      userId: opts.userId,
      versionId: opts.versionId,
      positionSecs: opts.positionSecs,
      completed: opts.completed,
      playCount: opts.playCount,
      updatedAt: opts.updatedAt,
    },
  });
}

describe("getWatchStats", () => {
  it("returns all-zero/empty stats for a user with no watch history", async () => {
    await seedUser("empty-user");
    const stats = await getWatchStats("empty-user");
    expect(stats).toEqual({
      totalWatchSecs: 0,
      totalFilmsWatched: 0,
      totalPlays: 0,
      mostWatched: [],
      topGenres: [],
      recentlyWatched: [],
    });
  });

  it("counts a completed film as runtime x playCount, and an in-progress film as its current position once", async () => {
    await seedUser("watch-time-user");
    // Completed twice, 1h version -> 3600 * 2 = 7200s.
    const completedFilm = await seedFilmWithVersion({
      title: "Completed Film",
      durationSecs: 3600,
    });
    await seedProgress({
      userId: "watch-time-user",
      versionId: completedFilm.versionId,
      positionSecs: 3600,
      completed: true,
      playCount: 2,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    // In progress, 30 minutes in, never completed -> counts as 1800s exactly
    // once, NOT multiplied by playCount (playCount is 1 here anyway, but the
    // point being tested is that positionSecs itself is the contribution).
    const inProgressFilm = await seedFilmWithVersion({
      title: "In Progress Film",
      durationSecs: 7200,
    });
    await seedProgress({
      userId: "watch-time-user",
      versionId: inProgressFilm.versionId,
      positionSecs: 1800,
      completed: false,
      playCount: 1,
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const stats = await getWatchStats("watch-time-user");
    expect(stats.totalWatchSecs).toBe(7200 + 1800);
    expect(stats.totalFilmsWatched).toBe(2);
    expect(stats.totalPlays).toBe(2 + 1);
  });

  it("falls back to positionSecs as the runtime stand-in when a completed row's Version has no probed durationSecs", async () => {
    await seedUser("no-duration-user");
    const film = await seedFilmWithVersion({ title: "Unprobed Film", durationSecs: null });
    await seedProgress({
      userId: "no-duration-user",
      versionId: film.versionId,
      positionSecs: 5000,
      completed: true,
      playCount: 3,
      updatedAt: new Date(),
    });

    const stats = await getWatchStats("no-duration-user");
    // 5000 (positionSecs standing in for runtime) * 3 plays.
    expect(stats.totalWatchSecs).toBe(5000 * 3);
  });

  it("excludes rows below the WATCH_PROGRESS_MIN_SECS floor entirely", async () => {
    await seedUser("preview-only-user");
    const film = await seedFilmWithVersion({ title: "Barely Started", durationSecs: 3600 });
    await seedProgress({
      userId: "preview-only-user",
      versionId: film.versionId,
      positionSecs: 5, // well under the 30s floor
      completed: false,
      playCount: 1,
      updatedAt: new Date(),
    });

    const stats = await getWatchStats("preview-only-user");
    expect(stats.totalWatchSecs).toBe(0);
    expect(stats.totalFilmsWatched).toBe(0);
    expect(stats.recentlyWatched).toEqual([]);
  });

  it("splits a row's contribution evenly across a film's comma-separated genres", async () => {
    await seedUser("genre-user");
    const film = await seedFilmWithVersion({
      title: "Genre Film",
      genres: "Action, Comedy",
      durationSecs: 4000,
    });
    await seedProgress({
      userId: "genre-user",
      versionId: film.versionId,
      positionSecs: 4000,
      completed: true,
      playCount: 1,
      updatedAt: new Date(),
    });

    const stats = await getWatchStats("genre-user");
    expect(stats.topGenres).toEqual(
      expect.arrayContaining([
        { genre: "Action", secs: 2000 },
        { genre: "Comedy", secs: 2000 },
      ]),
    );
    expect(stats.topGenres).toHaveLength(2);
  });

  it("ranks most-watched by playCount desc and dedupes multiple Versions of the same film", async () => {
    await seedUser("most-watched-user");
    const popular = await seedFilmWithVersion({ title: "Popular Film", durationSecs: 3000 });
    const lessPopular = await seedFilmWithVersion({ title: "Less Popular Film", durationSecs: 3000 });
    // A second rip of "Popular Film" — same film, different Version/row.
    const filmId = popular.filmId;
    const secondVersionId = nextVersionId++;
    await testPrisma.version.create({
      data: {
        id: secondVersionId,
        filmId,
        filePath: `/movies/popular-rip2-${secondVersionId}.mkv`,
        fileName: `popular-rip2-${secondVersionId}.mkv`,
        durationSecs: 3000,
      },
    });

    await seedProgress({
      userId: "most-watched-user",
      versionId: popular.versionId,
      positionSecs: 3000,
      completed: true,
      playCount: 5,
      updatedAt: new Date("2026-01-03T00:00:00Z"),
    });
    await seedProgress({
      userId: "most-watched-user",
      versionId: secondVersionId,
      positionSecs: 3000,
      completed: true,
      playCount: 2,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedProgress({
      userId: "most-watched-user",
      versionId: lessPopular.versionId,
      positionSecs: 100,
      completed: false,
      playCount: 1,
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const stats = await getWatchStats("most-watched-user");
    // Deduped to one card per film — "Popular Film" appears once, keeping
    // the most-recently-updated row's playCount (5), not summed (7) and not
    // the older row's (2).
    expect(stats.mostWatched.map((f) => f.title)).toEqual(["Popular Film", "Less Popular Film"]);
    expect(stats.mostWatched[0].playCount).toBe(5);
    // totalPlays is NOT deduped (5 + 2 + 1), reflecting every row.
    expect(stats.totalPlays).toBe(5 + 2 + 1);
    // totalFilmsWatched IS deduped by film (2 distinct titles, not 3 rows).
    expect(stats.totalFilmsWatched).toBe(2);
  });

  it("orders recentlyWatched by updatedAt desc", async () => {
    await seedUser("recent-user");
    const older = await seedFilmWithVersion({ title: "Older Watch", durationSecs: 1000 });
    const newer = await seedFilmWithVersion({ title: "Newer Watch", durationSecs: 1000 });
    await seedProgress({
      userId: "recent-user",
      versionId: older.versionId,
      positionSecs: 500,
      completed: false,
      playCount: 1,
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    });
    await seedProgress({
      userId: "recent-user",
      versionId: newer.versionId,
      positionSecs: 500,
      completed: false,
      playCount: 1,
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });

    const stats = await getWatchStats("recent-user");
    expect(stats.recentlyWatched.map((r) => r.film.title)).toEqual(["Newer Watch", "Older Watch"]);
  });
});
