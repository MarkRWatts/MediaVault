// The UltraHD block (src/lib/uhd-gate.ts) against a REAL, isolated SQLite
// database — same pattern and reasoning as age-filter.test.ts: the claim
// worth proving is "a request for a UHD version comes back 403", which is a
// claim about a row and a response, not about a mock's arguments.
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

const { uhdGate } = await import("@/lib/uhd-gate");
const { uhdPlaybackBlocked } = await import("@/lib/constants");

const VERSION = { uhd: 1, bluray: 2, unknown: 3 };

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;

  await testPrisma.film.create({
    data: { id: 1, title: "Dune", sortTitle: "dune", owned: true },
  });
  for (const [id, format] of [
    [VERSION.uhd, "UHD"],
    [VERSION.bluray, "BLURAY"],
    [VERSION.unknown, "UNKNOWN"],
  ] as const) {
    await testPrisma.version.create({
      data: { id, filmId: 1, format, filePath: `dune-${id}.mkv`, fileName: `dune-${id}.mkv`, videoCodec: "hevc" },
    });
  }
});

afterAll(async () => {
  await cleanupDb?.();
});

describe("uhdGate", () => {
  it("agrees with the pure rule the UI disables buttons from", () => {
    expect(uhdPlaybackBlocked({ format: "UHD" })).toBe(true);
    expect(uhdPlaybackBlocked({ format: "BLURAY" })).toBe(false);
  });

  it("refuses a UHD version with 403 and a machine-readable reason", async () => {
    const res = await uhdGate("film", VERSION.uhd);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // Native clients branch on this, so it is part of the contract.
    await expect(res!.json()).resolves.toEqual({ error: "uhd_playback_disabled" });
  });

  it("lets every other format through", async () => {
    expect(await uhdGate("film", VERSION.bluray)).toBeNull();
    expect(await uhdGate("film", VERSION.unknown)).toBeNull();
  });

  it("leaves an unknown version to the caller's own not-found", async () => {
    expect(await uhdGate("film", 9999)).toBeNull();
    expect(await uhdGate("film", Number.NaN)).toBeNull();
  });

  it("never blocks an episode — the id is an EpisodeFile, not a Version", async () => {
    // Without this, an episode file whose id happens to match a UHD
    // version's would be refused on the strength of a coincidence.
    expect(await uhdGate("episode", VERSION.uhd)).toBeNull();
  });
});
