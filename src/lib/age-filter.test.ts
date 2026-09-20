// End-to-end proof of the age-rating gate against a REAL, isolated SQLite
// database — same pattern as queries.test.ts, and for the same reason: the
// interesting claims here ("a 12-year-old cannot reach an 18", "an unrated
// film is invisible", "a collection with nothing left in it disappears") are
// claims about what the queries actually return, not about what arguments a
// mock received. src/lib/age-rating.test.ts covers the pure arithmetic; this
// covers the wiring.
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

const {
  getCollectionDetail,
  getCollections,
  getFilmDetail,
  getFavouriteFilms,
  getLibraryFilms,
  getPlayableCollections,
  getShowDetail,
  getShows,
} = await import("@/lib/queries");
const { canPlay } = await import("@/lib/age-gate");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  await seed();
});

afterAll(async () => {
  await cleanupDb?.();
});

// Ids are fixed so each test can name the thing it means.
const FILM = { u: 1, pg: 2, twelve: 3, fifteen: 4, eighteen: 5, unrated: 6, oddRating: 7 };
const VERSION = { u: 1, eighteen: 5, unrated: 6 };
const COLLECTION = { mixed: 100, adultOnly: 200 };
const SHOW = { pg: 1, eighteen: 2, unrated: 3 };
const EPISODE_FILE = { pg: 1, eighteen: 2 };

async function seedFilm(id: number, title: string, certification: string | null, collectionId?: number) {
  await testPrisma.film.create({
    data: { id, title, sortTitle: title.toLowerCase(), certification, owned: true, collectionId },
  });
  await testPrisma.version.create({
    data: { id, filmId: id, filePath: `${title}.mkv`, fileName: `${title}.mkv`, videoCodec: "h264" },
  });
}

async function seedShow(id: number, title: string, certification: string | null) {
  await testPrisma.show.create({
    data: { id, title, sortTitle: title.toLowerCase(), folder: title, certification },
  });
  await testPrisma.showSeason.create({ data: { id, showId: id, seasonNumber: 1 } });
  await testPrisma.episode.create({ data: { id, seasonId: id, episodeNumber: 1, owned: true } });
  await testPrisma.episodeFile.create({
    data: { id, episodeId: id, filePath: `${title}/s01e01.mkv`, fileName: "s01e01.mkv", videoCodec: "h264" },
  });
}

async function seed() {
  await testPrisma.user.create({
    data: { id: "kid", name: "Kid", email: "kid@example.com", emailVerified: true },
  });

  await testPrisma.collection.create({ data: { id: COLLECTION.mixed, name: "Mixed franchise" } });
  await testPrisma.collection.create({ data: { id: COLLECTION.adultOnly, name: "Grown-ups only" } });

  await seedFilm(FILM.u, "A U film", "U", COLLECTION.mixed);
  await seedFilm(FILM.pg, "A PG film", "PG", COLLECTION.mixed);
  await seedFilm(FILM.twelve, "A 12A film", "12A");
  await seedFilm(FILM.fifteen, "A 15 film", "15");
  await seedFilm(FILM.eighteen, "An 18 film", "18", COLLECTION.adultOnly);
  await seedFilm(FILM.unrated, "An unrated film", null, COLLECTION.adultOnly);
  await seedFilm(FILM.oddRating, "A TV-MA film", "TV-MA");

  await seedShow(SHOW.pg, "A PG show", "PG");
  await seedShow(SHOW.eighteen, "An 18 show", "18");
  await seedShow(SHOW.unrated, "An unrated show", null);

  for (const filmId of Object.values(FILM)) {
    await testPrisma.filmFavourite.create({ data: { userId: "kid", filmId } });
  }
}

describe("getLibraryFilms", () => {
  it("returns everything for an unrestricted viewer", async () => {
    const { films, filmCount } = await getLibraryFilms("unrestricted");
    expect(filmCount).toBe(7);
    expect(films.map((f) => f.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("gives a 12-year-old only U, PG and 12", async () => {
    const { films, filmCount } = await getLibraryFilms(12);
    expect(films.map((f) => f.id).sort((a, b) => a - b)).toEqual([FILM.u, FILM.pg, FILM.twelve]);
    // The count is the count of what they can see, not of the library.
    expect(filmCount).toBe(3);
  });

  it("hides an unrated film from every restricted viewer, including a 17-year-old", async () => {
    for (const age of [0, 7, 12, 15, 17]) {
      const { films } = await getLibraryFilms(age);
      expect(films.map((f) => f.id)).not.toContain(FILM.unrated);
      expect(films.map((f) => f.id)).not.toContain(FILM.oddRating);
    }
  });

  it("opens up with age", async () => {
    expect((await getLibraryFilms(15)).films.map((f) => f.id)).toContain(FILM.fifteen);
    expect((await getLibraryFilms(15)).films.map((f) => f.id)).not.toContain(FILM.eighteen);
    expect((await getLibraryFilms(18)).films.map((f) => f.id)).toContain(FILM.eighteen);
  });

  it("shows a 5-year-old only U and PG", async () => {
    const { films } = await getLibraryFilms(5);
    expect(films.map((f) => f.id).sort((a, b) => a - b)).toEqual([FILM.u, FILM.pg]);
  });
});

describe("getFavouriteFilms", () => {
  it("drops a favourite that is now above the viewer's limit", async () => {
    const all = await getFavouriteFilms("kid", "unrestricted");
    expect(all).toHaveLength(7);
    const limited = await getFavouriteFilms("kid", 12);
    expect(limited.map((f) => f.id).sort((a, b) => a - b)).toEqual([FILM.u, FILM.pg, FILM.twelve]);
  });
});

describe("getFilmDetail", () => {
  it("returns the film when the limit reaches it", async () => {
    expect(await getFilmDetail(FILM.twelve, 12)).not.toBeNull();
  });

  it("is null above the limit, and for an unrated film — same as a missing one", async () => {
    expect(await getFilmDetail(FILM.eighteen, 12)).toBeNull();
    expect(await getFilmDetail(FILM.unrated, 12)).toBeNull();
    expect(await getFilmDetail(FILM.oddRating, 17)).toBeNull();
    expect(await getFilmDetail(9999, "unrestricted")).toBeNull();
  });

  it("filters the sibling strip of the film's collection", async () => {
    const film = await getFilmDetail(FILM.u, 12);
    expect(film?.collection?.members.map((m) => m.id)).toEqual([FILM.u, FILM.pg]);
    const unrestricted = await getFilmDetail(FILM.u, "unrestricted");
    expect(unrestricted?.collection?.members).toHaveLength(2);
  });
});

describe("getShows", () => {
  it("rates a show by its own certificate and hides the whole wrapper above the limit", async () => {
    const shows = await getShows(12);
    expect(shows.map((s) => s.id)).toEqual([SHOW.pg]);
  });

  it("hides a show with no certificate at all", async () => {
    expect((await getShows(17)).map((s) => s.id)).toEqual([SHOW.pg]);
    expect((await getShows("unrestricted")).map((s) => s.id).sort()).toEqual([1, 2, 3]);
  });
});

describe("getShowDetail", () => {
  it("takes every season and episode with the show", async () => {
    expect(await getShowDetail(SHOW.eighteen, 12)).toBeNull();
    expect(await getShowDetail(SHOW.unrated, 17)).toBeNull();
    expect(await getShowDetail(SHOW.pg, 12)).not.toBeNull();
  });
});

describe("getCollections", () => {
  it("drops a collection whose films are all above the limit, wrapper and all", async () => {
    const names = (await getCollections(12)).map((c) => c.name);
    expect(names).toEqual(["Mixed franchise"]);
    expect(names).not.toContain("Grown-ups only");
  });

  it("counts only the films the viewer can see", async () => {
    const [mixed] = await getCollections(12);
    expect(mixed.totalCount).toBe(2);
    expect(mixed.ownedCount).toBe(2);
  });

  it("keeps both for an unrestricted viewer", async () => {
    expect((await getCollections("unrestricted")).map((c) => c.name).sort()).toEqual([
      "Grown-ups only",
      "Mixed franchise",
    ]);
  });
});

describe("getCollectionDetail", () => {
  it("is null when nothing in it survives the limit", async () => {
    expect(await getCollectionDetail(COLLECTION.adultOnly, 12)).toBeNull();
    expect(await getCollectionDetail(COLLECTION.adultOnly, "unrestricted")).not.toBeNull();
  });

  it("filters the timeline of a collection that partly survives", async () => {
    const detail = await getCollectionDetail(COLLECTION.mixed, 5);
    expect(detail?.films.map((f) => f.id)).toEqual([FILM.u, FILM.pg]);
  });
});

describe("getPlayableCollections", () => {
  it("applies the two-film threshold after the gate, not before", async () => {
    // Grown-ups only holds an 18 and an unrated film: two for an adult, none
    // for a 12-year-old — so it isn't a one-film collection for them, it
    // simply isn't there.
    expect((await getPlayableCollections("unrestricted")).map((c) => c.id).sort()).toEqual([
      COLLECTION.mixed,
      COLLECTION.adultOnly,
    ]);
    expect((await getPlayableCollections(12)).map((c) => c.id)).toEqual([COLLECTION.mixed]);
  });
});

describe("canPlay — the streaming gate", () => {
  it("lets an unrestricted viewer play anything", async () => {
    expect(await canPlay("unrestricted", "film", VERSION.eighteen)).toBe(true);
    expect(await canPlay("unrestricted", "scene", 1)).toBe(true);
  });

  it("refuses a film version above the limit, by id, with no listing involved", async () => {
    expect(await canPlay(12, "film", VERSION.u)).toBe(true);
    expect(await canPlay(12, "film", VERSION.eighteen)).toBe(false);
    expect(await canPlay(12, "film", VERSION.unrated)).toBe(false);
  });

  it("refuses an episode file whose show is above the limit", async () => {
    expect(await canPlay(12, "episode", EPISODE_FILE.pg)).toBe(true);
    expect(await canPlay(12, "episode", EPISODE_FILE.eighteen)).toBe(false);
  });

  it("refuses the Adult media type outright for any restricted viewer", async () => {
    expect(await canPlay(18, "scene", 1)).toBe(false);
    expect(await canPlay(99, "scene", 1)).toBe(false);
  });

  it("leaves an unknown id to the caller's own not-found handling", async () => {
    expect(await canPlay(12, "film", 9999)).toBe(true);
    expect(await canPlay(12, "episode", 9999)).toBe(true);
  });
});
