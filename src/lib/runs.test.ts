// guardAndCreateRun against a REAL SQLite database (same pattern as
// access.test.ts): the thing under test is a check-then-create race, which
// a mocked Prisma can't exhibit.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { guardAndCreateRun, finishRun } = await import("@/lib/runs");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});
afterAll(async () => {
  await cleanupDb();
});
beforeEach(async () => {
  await testPrisma.scanRun.deleteMany({});
});

describe("guardAndCreateRun", () => {
  it("starts one run, then refuses a second of the same kind", async () => {
    const first = await guardAndCreateRun("SCAN_FILM");
    expect(first.started).toBe(true);
    const second = await guardAndCreateRun("SCAN_FILM");
    expect(second.started).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it("lets a different kind run alongside", async () => {
    await guardAndCreateRun("SCAN_FILM");
    expect((await guardAndCreateRun("ENRICH_FILM")).started).toBe(true);
  });

  it("exactly one of many concurrent callers starts (the race this guards)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => guardAndCreateRun("SCAN_MUSIC")));
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(await testPrisma.scanRun.count({ where: { kind: "SCAN_MUSIC", status: "RUNNING" } })).toBe(1);
  });

  it("allows a new run once the previous one finished", async () => {
    const first = await guardAndCreateRun("SCAN_TV");
    await finishRun(first.run.id, []);
    const next = await guardAndCreateRun("SCAN_TV");
    expect(next.started).toBe(true);
    expect(next.run.id).not.toBe(first.run.id);
  });

  it("supersedes a RUNNING row older than the stale window", async () => {
    const stale = await testPrisma.scanRun.create({
      data: { kind: "JELLYFIN", status: "RUNNING", startedAt: new Date(Date.now() - 31 * 60_000) },
    });
    const next = await guardAndCreateRun("JELLYFIN");
    expect(next.started).toBe(true);
    expect((await testPrisma.scanRun.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
  });
});
