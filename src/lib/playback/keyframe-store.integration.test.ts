// Real SQLite (see src/lib/test-temp-db.ts) rather than a mocked Prisma
// client: the stale-cache-key check depends on an actual round trip through
// the Bytes column and the (kind, fileId) unique constraint driving the
// upsert, not just on what args a mock recorded.
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

let store: typeof import("./keyframe-store");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  store = await import("./keyframe-store");
});

afterAll(async () => {
  await cleanupDb();
});

describe("loadKeyframeIndex / saveKeyframeIndex", () => {
  it("returns null when nothing has been cached yet", async () => {
    expect(await store.loadKeyframeIndex("film", 1, { mtimeMs: 100, sizeBytes: BigInt(1000) })).toBeNull();
  });

  it("saves and reloads a fresh index", async () => {
    await store.saveKeyframeIndex(
      "film",
      2,
      { mtimeMs: 100, sizeBytes: BigInt(1000) },
      { keyframeSecs: [0, 6.5, 12], source: "cues" },
    );
    const loaded = await store.loadKeyframeIndex("film", 2, { mtimeMs: 100, sizeBytes: BigInt(1000) });
    expect(loaded).toEqual({ keyframeSecs: [0, 6.5, 12], source: "cues" });
  });

  it("returns null once the source file's mtime has moved on", async () => {
    await store.saveKeyframeIndex("episode", 3, { mtimeMs: 100, sizeBytes: BigInt(1000) }, { keyframeSecs: [0, 6], source: "ffprobe" });
    expect(await store.loadKeyframeIndex("episode", 3, { mtimeMs: 200, sizeBytes: BigInt(1000) })).toBeNull();
  });

  it("returns null once the source file's size has moved on", async () => {
    await store.saveKeyframeIndex("episode", 4, { mtimeMs: 100, sizeBytes: BigInt(1000) }, { keyframeSecs: [0, 6], source: "ffprobe" });
    expect(await store.loadKeyframeIndex("episode", 4, { mtimeMs: 100, sizeBytes: BigInt(1001) })).toBeNull();
  });

  it("(kind, fileId) are independent — film 5 and episode 5 don't collide", async () => {
    await store.saveKeyframeIndex("film", 5, { mtimeMs: 1, sizeBytes: BigInt(1) }, { keyframeSecs: [1], source: "cues" });
    await store.saveKeyframeIndex("episode", 5, { mtimeMs: 2, sizeBytes: BigInt(2) }, { keyframeSecs: [2], source: "ffprobe" });
    expect(await store.loadKeyframeIndex("film", 5, { mtimeMs: 1, sizeBytes: BigInt(1) })).toEqual({ keyframeSecs: [1], source: "cues" });
    expect(await store.loadKeyframeIndex("episode", 5, { mtimeMs: 2, sizeBytes: BigInt(2) })).toEqual({ keyframeSecs: [2], source: "ffprobe" });
  });

  it("re-saving the same key overwrites rather than duplicating", async () => {
    await store.saveKeyframeIndex("film", 6, { mtimeMs: 1, sizeBytes: BigInt(1) }, { keyframeSecs: [1, 2], source: "cues" });
    await store.saveKeyframeIndex("film", 6, { mtimeMs: 2, sizeBytes: BigInt(2) }, { keyframeSecs: [3, 4, 5], source: "ffprobe" });
    expect(await store.loadKeyframeIndex("film", 6, { mtimeMs: 2, sizeBytes: BigInt(2) })).toEqual({ keyframeSecs: [3, 4, 5], source: "ffprobe" });
    expect(await store.loadKeyframeIndex("film", 6, { mtimeMs: 1, sizeBytes: BigInt(1) })).toBeNull();
  });
});
