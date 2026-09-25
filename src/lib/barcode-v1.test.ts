// toBarcodeResponse() against a real, isolated SQLite database (the same
// pattern as queries.test.ts): the part worth checking is the "owned as"
// lookup — that a not-owned LP still reports the CD already on the shelf,
// and an owned film lists its discs and its rip.
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

const { toBarcodeResponse, ownedAsFrom } = await import("@/lib/barcode-v1");
const { resolveOwned, barcodeVariants } = await import("@/lib/scan-resolve");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;

  await testPrisma.artist.create({ data: { id: 1, name: "Talk Talk", sortName: "talk talk" } });
  await testPrisma.album.create({
    data: {
      id: 10,
      artistId: 1,
      title: "Spirit of Eden",
      sortTitle: "spirit of eden",
      year: 1988,
      discogsMasterId: 555,
      owned: true,
      physicalCopies: { create: [{ medium: "CD", format: "CD", barcode: "0077774615626" }] },
    },
  });
  await testPrisma.film.create({
    data: {
      id: 20,
      title: "Heat",
      sortTitle: "heat",
      year: 1995,
      tmdbId: 949,
      posterPath: "/heat.jpg",
      owned: true,
      physicalCopies: { create: [{ medium: "BLURAY" }, { medium: "UHD" }] },
    },
  });
});

afterAll(async () => {
  await cleanupDb?.();
});

describe("ownedAsFrom", () => {
  it("orders vinyl before CD and a rip last, and drops repeats", () => {
    expect(
      ownedAsFrom(
        [
          { medium: "CD", format: "CD" },
          { medium: "VINYL", format: "LP" },
          { medium: "CD", format: "CD" },
        ],
        true,
      ),
    ).toEqual([
      { medium: "VINYL", format: "LP" },
      { medium: "CD", format: "CD" },
      { medium: "DIGITAL", format: null },
    ]);
  });
});

describe("toBarcodeResponse", () => {
  it("is unknown when nothing recognised the barcode", async () => {
    expect(await toBarcodeResponse("123", { status: "unknown" })).toEqual({
      barcode: "123",
      status: "unknown",
      match: null,
    });
  });

  it("reports an LP as not owned, but lists the CD already owned", async () => {
    const res = await toBarcodeResponse("0077774615619", {
      status: "not_owned",
      type: "album",
      candidate: {
        discogsMasterId: 555,
        discogsReleaseId: 999,
        title: "Spirit Of Eden",
        artistName: "Talk Talk",
        year: 1988,
        format: "Vinyl, LP, Album",
        coverArtUrl: "https://i.discogs.com/x.jpg",
      },
    });
    expect(res.status).toBe("not_owned");
    expect(res.match).toMatchObject({
      kind: "album",
      scannedMedium: "VINYL",
      libraryId: 10,
      artwork: "https://i.discogs.com/x.jpg",
      ownedAs: [
        { medium: "CD", format: "CD" },
        { medium: "DIGITAL", format: null },
      ],
    });
  });

  it("carries the scanned medium through for an owned album", async () => {
    const res = await toBarcodeResponse("0077774615626", {
      status: "owned",
      type: "album",
      album: { id: 10, title: "Spirit of Eden", artistName: "Talk Talk", year: 1988, coverPath: null },
      medium: "CD",
    });
    expect(res.match).toMatchObject({ kind: "album", scannedMedium: "CD", artistName: "Talk Talk", artwork: null });
  });

  it("lists an owned film's discs and rip", async () => {
    const res = await toBarcodeResponse("5051892008811", {
      status: "owned",
      type: "film",
      film: { id: 20, title: "Heat", year: 1995, posterPath: "/heat.jpg" },
    });
    expect(res.match).toMatchObject({
      kind: "film",
      scannedMedium: null,
      artwork: "/api/poster/w342/heat.jpg",
      ownedAs: [{ medium: "UHD" }, { medium: "BLURAY" }, { medium: "DIGITAL" }],
    });
  });

  it("finds no library row for a film nobody has", async () => {
    const res = await toBarcodeResponse("5050582", {
      status: "not_owned",
      type: "film",
      candidate: { tmdbId: 1, title: "Somebody Else's Film", year: 2001, posterPath: null },
    });
    expect(res.match).toMatchObject({ libraryId: null, ownedAs: [], artwork: null });
  });
});

describe("resolveOwned", () => {
  it("matches a stored EAN-13 from its 12-digit UPC-A, and back", async () => {
    expect(barcodeVariants("077774615626")).toEqual(["077774615626", "0077774615626"]);
    const res = await resolveOwned("077774615626");
    expect(res).toMatchObject({ status: "owned", type: "album", medium: "CD" });
  });
});
