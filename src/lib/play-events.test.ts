// The one rule worth pinning down in play-events.ts: when a report joins
// the sitting before it and when it starts a new one. Everything else the
// helper does is a straight column write.
//
// Same REAL, isolated SQLite database pattern as music-user-state.test.ts —
// the coalescing turns on an ordered lastSeenAt lookup and a foreign key to
// the user table, neither of which a Prisma mock would actually exercise.
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

const { recordPlayEvent, PLAY_EVENT_COALESCE_MS } = await import("@/lib/play-events");

const USER = "viewer-1";
const OTHER = "viewer-2";

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  for (const id of [USER, OTHER]) {
    await testPrisma.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
  }
});

afterAll(async () => {
  await cleanupDb?.();
});

beforeEach(async () => {
  await testPrisma.playEvent.deleteMany({});
});

/** Backdate a row's lastSeenAt, standing in for time having passed. */
async function ageBy(id: number, ms: number) {
  const row = await testPrisma.playEvent.findUniqueOrThrow({ where: { id } });
  await testPrisma.playEvent.update({
    where: { id },
    data: { lastSeenAt: new Date(row.lastSeenAt.getTime() - ms) },
  });
}

function events() {
  return testPrisma.playEvent.findMany({ orderBy: { id: "asc" } });
}

describe("recordPlayEvent", () => {
  it("starts a row when the user has never played the item", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 12.6 });
    const [row] = await events();
    expect(row).toMatchObject({ userId: USER, kind: "film", itemId: 7, positionSecs: 13, completed: false });
    expect(row.startedAt.getTime()).toBe(row.lastSeenAt.getTime());
  });

  it("folds a later report into the same sitting", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 30 });
    const [first] = await events();
    await ageBy(first.id, PLAY_EVENT_COALESCE_MS - 60_000);

    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, positionSecs: 4200, completed: true });
    // The sitting keeps the moment it began, not the moment of the report.
    expect(rows[0].startedAt.getTime()).toBe(first.startedAt.getTime());
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(rows[0].startedAt.getTime());
  });

  it("starts a new sitting once the window has passed", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });
    const [first] = await events();
    await ageBy(first.id, PLAY_EVENT_COALESCE_MS + 60_000);

    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 15 });

    const rows = await events();
    expect(rows).toHaveLength(2);
    // The finished watch stays finished; the rewatch begins at zero again.
    expect(rows[0]).toMatchObject({ completed: true, positionSecs: 4200 });
    expect(rows[1]).toMatchObject({ completed: false, positionSecs: 15 });
  });

  it("starts a fresh sitting when the player says a finished film was restarted", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });
    // Inside the coalescing window, so without the flag this would fold in.
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 5, isNewPlay: true });

    const rows = await events();
    expect(rows).toHaveLength(2);
    // The watch that happened stays a watch.
    expect(rows[0]).toMatchObject({ completed: true, positionSecs: 4200 });
    expect(rows[1]).toMatchObject({ completed: false, positionSecs: 5 });
  });

  it("infers the restart from the position when the caller sends no flag", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 12 });

    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[0].completed).toBe(true);
  });

  it("folds a late report back into a finished sitting rather than splitting it", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });
    // The credits ran on: still the same viewing, well past the restart floor.
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4320, isNewPlay: false });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completed: true, positionSecs: 4320 });
  });

  it("never un-watches a sitting it folds a report into", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 4200, completed: true });
    // A scrub backwards re-reports completed: false, but the film was watched.
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 3000, completed: false });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completed: true, positionSecs: 3000 });
  });

  it("coalesces per item and per person, not globally", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 30 });
    await recordPlayEvent({ userId: USER, kind: "episode", itemId: 7, positionSecs: 30 });
    await recordPlayEvent({ userId: OTHER, kind: "film", itemId: 7, positionSecs: 30 });

    expect(await events()).toHaveLength(3);
  });

  it("leaves the position alone when a report carries none", async () => {
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7, positionSecs: 90 });
    await recordPlayEvent({ userId: USER, kind: "film", itemId: 7 });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].positionSecs).toBe(90);
  });

  it("records a track play with no position at all", async () => {
    await recordPlayEvent({ userId: USER, kind: "track", itemId: 41 });
    const [row] = await events();
    expect(row).toMatchObject({ kind: "track", itemId: 41, positionSecs: null, completed: false });
  });
});
