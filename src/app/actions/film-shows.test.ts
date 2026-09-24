// Exercises the film-to-show link actions against a REAL, isolated SQLite
// database — same pattern as household.test.ts. What this pins is the part
// that isn't visible from the show page: the owner gate holds for a signed-in
// non-owner, a concert can't be linked at all, and linking twice is quiet
// rather than an error.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const { linkFilmToShow, unlinkFilmFromShow } = await import("@/app/actions/film-shows");

const FILM = 1;
const CONCERT = 2;
const SHOW = 1;

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;

  await testPrisma.user.create({
    data: { id: "mark", name: "mark", email: "mark@example.com", emailVerified: true, isAppOwner: true },
  });
  await testPrisma.user.create({
    data: { id: "sam", name: "sam", email: "sam@example.com", emailVerified: true, isAppOwner: false },
  });
  await testPrisma.film.create({ data: { id: FILM, title: "Serenity", sortTitle: "serenity" } });
  await testPrisma.film.create({
    data: { id: CONCERT, title: "Live at Pompeii", sortTitle: "live at pompeii", kind: "CONCERT" },
  });
  await testPrisma.show.create({
    data: { id: SHOW, title: "Firefly", sortTitle: "firefly", folder: "Firefly" },
  });
});

afterEach(async () => {
  getSession.mockReset();
  revalidatePath.mockReset();
  await testPrisma.filmShowLink.deleteMany();
});

afterAll(async () => {
  await cleanupDb?.();
});

function signedInAs(userId: string | null) {
  getSession.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

function form(filmId: unknown, showId: unknown): FormData {
  const data = new FormData();
  if (filmId !== undefined) data.set("filmId", String(filmId));
  if (showId !== undefined) data.set("showId", String(showId));
  return data;
}

describe("linkFilmToShow", () => {
  it("refuses anyone who isn't the app owner", async () => {
    signedInAs("sam");
    await expect(linkFilmToShow(null, form(FILM, SHOW))).rejects.toThrow(/app owner/i);
    expect(await testPrisma.filmShowLink.count()).toBe(0);
  });

  it("refuses a request with no session at all", async () => {
    signedInAs(null);
    await expect(linkFilmToShow(null, form(FILM, SHOW))).rejects.toThrow(/app owner/i);
  });

  it("links the film and re-renders both pages", async () => {
    signedInAs("mark");
    expect(await linkFilmToShow(null, form(FILM, SHOW))).toBeNull();
    expect(await testPrisma.filmShowLink.count({ where: { filmId: FILM, showId: SHOW } })).toBe(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/film/${FILM}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/shows/${SHOW}`);
  });

  it("is quiet when the link already exists", async () => {
    signedInAs("mark");
    await linkFilmToShow(null, form(FILM, SHOW));
    expect(await linkFilmToShow(null, form(FILM, SHOW))).toBeNull();
    expect(await testPrisma.filmShowLink.count()).toBe(1);
  });

  it("refuses a concert", async () => {
    signedInAs("mark");
    expect(await linkFilmToShow(null, form(CONCERT, SHOW))).toEqual({
      error: "Concerts can't be linked to a show.",
    });
    expect(await testPrisma.filmShowLink.count()).toBe(0);
  });

  it("refuses ids that don't exist or aren't ids", async () => {
    signedInAs("mark");
    expect(await linkFilmToShow(null, form(FILM, ""))).toEqual({ error: "Choose a show." });
    expect(await linkFilmToShow(null, form(9999, SHOW))).toEqual({ error: "No such film." });
    expect(await linkFilmToShow(null, form(FILM, 9999))).toEqual({ error: "No such show." });
    expect(await testPrisma.filmShowLink.count()).toBe(0);
  });
});

describe("unlinkFilmFromShow", () => {
  it("refuses anyone who isn't the app owner", async () => {
    await testPrisma.filmShowLink.create({ data: { filmId: FILM, showId: SHOW } });
    signedInAs("sam");
    await expect(unlinkFilmFromShow(null, form(FILM, SHOW))).rejects.toThrow(/app owner/i);
    expect(await testPrisma.filmShowLink.count()).toBe(1);
  });

  it("removes the link and re-renders both pages", async () => {
    await testPrisma.filmShowLink.create({ data: { filmId: FILM, showId: SHOW } });
    signedInAs("mark");
    expect(await unlinkFilmFromShow(null, form(FILM, SHOW))).toBeNull();
    expect(await testPrisma.filmShowLink.count()).toBe(0);
    expect(revalidatePath).toHaveBeenCalledWith(`/film/${FILM}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/shows/${SHOW}`);
  });

  it("treats a link that has already gone as done", async () => {
    signedInAs("mark");
    expect(await unlinkFilmFromShow(null, form(FILM, SHOW))).toBeNull();
  });
});
