// Covers queries-film-shows.ts against a REAL, isolated SQLite database —
// same pattern and the same reasoning as age-filter.test.ts: the claims here
// ("the Stargate film appears under all three shows", "a 12-year-old doesn't
// see the 15 linked to a PG show", "an unripped film isn't on the shelf")
// are claims about what the queries return, not about mock arguments.
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

const { getFilmShows, getLinkableShows, getShowFilms } = await import("@/lib/queries-film-shows");

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
const SHOW = { sg1: 1, atlantis: 2, universe: 3, unrated: 4, lonely: 5 };
const FILM = {
  stargate: 1, // 1994, linked to all three SG shows
  continuum: 2, // 2008, same shelf — proves year order
  ark: 3, // no year at all — sorts last
  fifteen: 4, // a 15 on the SG-1 shelf
  unowned: 5, // a missing-film row
  concert: 6, // kind=CONCERT
};

async function seedShow(id: number, title: string, certification: string | null) {
  await testPrisma.show.create({
    data: { id, title, sortTitle: title.toLowerCase(), folder: title, certification },
  });
}

async function seedFilm(
  id: number,
  title: string,
  opts: { year?: number | null; certification?: string | null; owned?: boolean; kind?: string } = {},
) {
  await testPrisma.film.create({
    data: {
      id,
      title,
      sortTitle: title.toLowerCase(),
      year: opts.year ?? null,
      certification: opts.certification ?? "PG",
      owned: opts.owned ?? true,
      kind: opts.kind ?? "FILM",
    },
  });
}

async function seed() {
  await seedShow(SHOW.sg1, "Stargate SG-1", "PG");
  await seedShow(SHOW.atlantis, "Stargate Atlantis", "PG");
  await seedShow(SHOW.universe, "Stargate Universe", "12");
  await seedShow(SHOW.unrated, "Unrated Show", null);
  await seedShow(SHOW.lonely, "Lonely", null);

  await seedFilm(FILM.stargate, "Stargate", { year: 1994 });
  await seedFilm(FILM.continuum, "Stargate: Continuum", { year: 2008 });
  await seedFilm(FILM.ark, "Stargate: The Ark of Truth", { year: null });
  await seedFilm(FILM.fifteen, "A Fifteen", { year: 2001, certification: "15" });
  await seedFilm(FILM.unowned, "Not Ripped Yet", { year: 1999, owned: false });
  await seedFilm(FILM.concert, "A Concert", { year: 1995, kind: "CONCERT" });

  await testPrisma.filmShowLink.createMany({
    data: [
      // The whole reason the link is many-to-many.
      { filmId: FILM.stargate, showId: SHOW.sg1 },
      { filmId: FILM.stargate, showId: SHOW.atlantis },
      { filmId: FILM.stargate, showId: SHOW.universe },
      { filmId: FILM.continuum, showId: SHOW.sg1 },
      { filmId: FILM.ark, showId: SHOW.sg1 },
      { filmId: FILM.fifteen, showId: SHOW.sg1 },
      { filmId: FILM.unowned, showId: SHOW.sg1 },
      { filmId: FILM.concert, showId: SHOW.sg1 },
      // Links a restricted viewer must not be able to follow.
      { filmId: FILM.stargate, showId: SHOW.unrated },
    ],
  });
}

describe("getShowFilms", () => {
  it("returns the linked films oldest first, with the yearless one last", async () => {
    const films = await getShowFilms(SHOW.sg1, "unrestricted");
    expect(films.map((f) => f.title)).toEqual([
      "Stargate",
      "A Fifteen",
      "Stargate: Continuum",
      "Stargate: The Ark of Truth",
    ]);
  });

  it("leaves out concerts and films that aren't owned", async () => {
    const films = await getShowFilms(SHOW.sg1, "unrestricted");
    expect(films.map((f) => f.id)).not.toContain(FILM.concert);
    expect(films.map((f) => f.id)).not.toContain(FILM.unowned);
  });

  it("hides a film above the viewer's age limit", async () => {
    const films = await getShowFilms(SHOW.sg1, 12);
    expect(films.map((f) => f.title)).toEqual([
      "Stargate",
      "Stargate: Continuum",
      "Stargate: The Ark of Truth",
    ]);
  });

  it("puts the same film on every show it was linked to", async () => {
    for (const showId of [SHOW.sg1, SHOW.atlantis, SHOW.universe]) {
      const films = await getShowFilms(showId, "unrestricted");
      expect(films.map((f) => f.id)).toContain(FILM.stargate);
    }
  });

  it("is empty for a show nobody has linked anything to", async () => {
    expect(await getShowFilms(SHOW.lonely, "unrestricted")).toEqual([]);
  });
});

describe("getFilmShows", () => {
  it("lists every show the film is linked to, alphabetically", async () => {
    const shows = await getFilmShows(FILM.stargate, "unrestricted");
    expect(shows.map((s) => s.title)).toEqual([
      "Stargate Atlantis",
      "Stargate SG-1",
      "Stargate Universe",
      "Unrated Show",
    ]);
  });

  it("drops shows the viewer's age limit doesn't reach, including unrated ones", async () => {
    const shows = await getFilmShows(FILM.stargate, 10);
    expect(shows.map((s) => s.title)).toEqual(["Stargate Atlantis", "Stargate SG-1"]);
  });

  it("is empty for a film with no links", async () => {
    const film = await testPrisma.film.create({
      data: { title: "Standalone", sortTitle: "standalone" },
    });
    expect(await getFilmShows(film.id, "unrestricted")).toEqual([]);
  });
});

describe("getLinkableShows", () => {
  it("offers every show in the library, alphabetically", async () => {
    const shows = await getLinkableShows("unrestricted");
    expect(shows.map((s) => s.title)).toEqual([
      "Lonely",
      "Stargate Atlantis",
      "Stargate SG-1",
      "Stargate Universe",
      "Unrated Show",
    ]);
  });

  it("respects an age limit like every other content query", async () => {
    const shows = await getLinkableShows(10);
    expect(shows.map((s) => s.title)).toEqual(["Stargate Atlantis", "Stargate SG-1"]);
  });
});

describe("the link itself", () => {
  it("cascades away with the film", async () => {
    const film = await testPrisma.film.create({
      data: { title: "Doomed", sortTitle: "doomed" },
    });
    await testPrisma.filmShowLink.create({ data: { filmId: film.id, showId: SHOW.sg1 } });
    await testPrisma.film.delete({ where: { id: film.id } });
    expect(await testPrisma.filmShowLink.count({ where: { filmId: film.id } })).toBe(0);
  });

  it("cascades away with the show", async () => {
    const show = await testPrisma.show.create({
      data: { title: "Doomed Show", sortTitle: "doomed show", folder: "Doomed Show" },
    });
    await testPrisma.filmShowLink.create({ data: { filmId: FILM.stargate, showId: show.id } });
    await testPrisma.show.delete({ where: { id: show.id } });
    expect(await testPrisma.filmShowLink.count({ where: { showId: show.id } })).toBe(0);
  });

  it("can only be made once per film and show", async () => {
    await expect(
      testPrisma.filmShowLink.create({ data: { filmId: FILM.stargate, showId: SHOW.sg1 } }),
    ).rejects.toThrow();
  });
});
