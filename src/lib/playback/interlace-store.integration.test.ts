// Real SQLite (see src/lib/test-temp-db.ts) rather than a mocked Prisma
// client: the stale-cache-key check depends on an actual round trip through
// the (kind, fileId) unique constraint driving the upsert, not just on what
// args a mock recorded -- the same reasoning keyframe-store.integration.test.ts
// gives for InterlaceCheck's sibling table.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let store: typeof import("./interlace-store");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  store = await import("./interlace-store");
});

afterAll(async () => {
  await cleanupDb();
});

describe("loadInterlaceCheck / saveInterlaceCheck", () => {
  it("returns null when nothing has been cached yet", async () => {
    expect(await store.loadInterlaceCheck("film", 1, { mtimeMs: 100, sizeBytes: BigInt(1000) })).toBeNull();
  });

  it("saves and reloads a fresh measurement", async () => {
    await store.saveInterlaceCheck(
      "film",
      2,
      { mtimeMs: 100, sizeBytes: BigInt(1000) },
      { sampledFrames: 900, interlacedFrames: 0 },
    );
    const loaded = await store.loadInterlaceCheck("film", 2, { mtimeMs: 100, sizeBytes: BigInt(1000) });
    expect(loaded).toEqual({ sampledFrames: 900, interlacedFrames: 0 });
  });

  it("returns null once the source file's mtime has moved on", async () => {
    await store.saveInterlaceCheck(
      "episode",
      3,
      { mtimeMs: 100, sizeBytes: BigInt(1000) },
      { sampledFrames: 900, interlacedFrames: 900 },
    );
    expect(await store.loadInterlaceCheck("episode", 3, { mtimeMs: 200, sizeBytes: BigInt(1000) })).toBeNull();
  });

  it("returns null once the source file's size has moved on", async () => {
    await store.saveInterlaceCheck(
      "episode",
      4,
      { mtimeMs: 100, sizeBytes: BigInt(1000) },
      { sampledFrames: 900, interlacedFrames: 900 },
    );
    expect(await store.loadInterlaceCheck("episode", 4, { mtimeMs: 100, sizeBytes: BigInt(1001) })).toBeNull();
  });

  it("(kind, fileId) are independent -- film 5 and episode 5 don't collide", async () => {
    await store.saveInterlaceCheck("film", 5, { mtimeMs: 1, sizeBytes: BigInt(1) }, { sampledFrames: 900, interlacedFrames: 0 });
    await store.saveInterlaceCheck("episode", 5, { mtimeMs: 2, sizeBytes: BigInt(2) }, { sampledFrames: 900, interlacedFrames: 900 });
    expect(await store.loadInterlaceCheck("film", 5, { mtimeMs: 1, sizeBytes: BigInt(1) })).toEqual({
      sampledFrames: 900,
      interlacedFrames: 0,
    });
    expect(await store.loadInterlaceCheck("episode", 5, { mtimeMs: 2, sizeBytes: BigInt(2) })).toEqual({
      sampledFrames: 900,
      interlacedFrames: 900,
    });
  });

  it("re-saving the same key overwrites rather than duplicating", async () => {
    await store.saveInterlaceCheck("film", 6, { mtimeMs: 1, sizeBytes: BigInt(1) }, { sampledFrames: 900, interlacedFrames: 0 });
    await store.saveInterlaceCheck("film", 6, { mtimeMs: 2, sizeBytes: BigInt(2) }, { sampledFrames: 900, interlacedFrames: 900 });
    expect(await store.loadInterlaceCheck("film", 6, { mtimeMs: 2, sizeBytes: BigInt(2) })).toEqual({
      sampledFrames: 900,
      interlacedFrames: 900,
    });
    expect(await store.loadInterlaceCheck("film", 6, { mtimeMs: 1, sizeBytes: BigInt(1) })).toBeNull();
  });
});
