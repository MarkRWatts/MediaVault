// The periodic sync's two decisions worth pinning down: whether it runs at
// all (env parsing, where "unset in dev" and "0" both mean off), and what
// one tick does (order, skips, and the rule that no single failure may cost
// the rest of the pass). The run functions are injected, so nothing here
// touches a library, an API or the database — @/lib/db is stubbed only
// because importing the module reaches it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

const { parseSyncIntervalMs, runSyncTick } = await import("@/lib/scheduler");

type MediaType = "FILM" | "TV" | "MUSIC" | "SCENE" | "CONCERT";

function makeDeps(overrides: Partial<Parameters<typeof runSyncTick>[0]> = {}) {
  const calls: string[] = [];
  let nextRunId = 1;
  const deps = {
    mediaTypes: ["FILM", "MUSIC"] as MediaType[],
    libraryConfigured: () => true,
    startScan: async (mediaType: MediaType) => {
      calls.push(`scan:${mediaType}`);
      return { runId: nextRunId++, started: true };
    },
    startEnrich: async (mediaType: MediaType) => {
      calls.push(`enrich:${mediaType}`);
      return { runId: nextRunId++, started: true };
    },
    startJellyfinSync: async () => {
      calls.push("jellyfin");
      return { runId: nextRunId++, started: true };
    },
    waitForRun: async (runId: number) => {
      calls.push(`wait:${runId}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseSyncIntervalMs", () => {
  it("defaults to four hours in production", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "production" })).toBe(4 * 3_600_000);
  });

  it("stays off when unset outside production, so next dev never scans on its own", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "development" })).toBeNull();
    expect(parseSyncIntervalMs({ NODE_ENV: "test" })).toBeNull();
  });

  it("honours an explicit interval in development", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "development", SYNC_INTERVAL_HOURS: "6" })).toBe(6 * 3_600_000);
  });

  it("takes fractional hours", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "production", SYNC_INTERVAL_HOURS: "0.01" })).toBe(36_000);
  });

  it("treats 0 as off, in either environment", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "production", SYNC_INTERVAL_HOURS: "0" })).toBeNull();
    expect(parseSyncIntervalMs({ NODE_ENV: "development", SYNC_INTERVAL_HOURS: "0" })).toBeNull();
  });

  it("stays off rather than guessing when the value isn't a number of hours", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "production", SYNC_INTERVAL_HOURS: "nightly" })).toBeNull();
    expect(parseSyncIntervalMs({ NODE_ENV: "production", SYNC_INTERVAL_HOURS: "-2" })).toBeNull();
  });

  it("clamps an absurd interval to what setTimeout can actually hold", () => {
    expect(parseSyncIntervalMs({ NODE_ENV: "production", SYNC_INTERVAL_HOURS: "100000" })).toBe(2 ** 31 - 1);
  });
});

describe("runSyncTick", () => {
  it("scans every library, then fetches metadata, then relinks Jellyfin", async () => {
    const { deps, calls } = makeDeps();
    await runSyncTick(deps);
    expect(calls).toEqual([
      "scan:FILM",
      "wait:1",
      "scan:MUSIC",
      "wait:2",
      "enrich:FILM",
      "wait:3",
      "enrich:MUSIC",
      "wait:4",
      "jellyfin",
      "wait:5",
    ]);
  });

  it("leaves out a library whose path isn't configured", async () => {
    const { deps, calls } = makeDeps({ libraryConfigured: (mediaType) => mediaType !== "MUSIC" });
    await runSyncTick(deps);
    expect(calls.filter((c) => c.includes("MUSIC"))).toEqual([]);
    expect(calls).toContain("scan:FILM");
    expect(calls).toContain("jellyfin");
  });

  it("skips a kind that's already running instead of waiting on someone else's run", async () => {
    const { deps, calls } = makeDeps({
      startScan: async (mediaType: MediaType) => {
        calls.push(`scan:${mediaType}`);
        return mediaType === "FILM" ? { runId: 99, started: false } : { runId: 100, started: true };
      },
    });
    await runSyncTick(deps);
    expect(calls).toContain("scan:FILM");
    expect(calls).not.toContain("wait:99");
    expect(calls).toContain("wait:100");
  });

  it("does nothing for a library with no metadata source", async () => {
    const { deps, calls } = makeDeps({
      startEnrich: async (mediaType: MediaType) => {
        calls.push(`enrich:${mediaType}`);
        return mediaType === "MUSIC" ? null : { runId: 7, started: true };
      },
    });
    await runSyncTick(deps);
    expect(calls).toContain("enrich:MUSIC");
    expect(calls.filter((c) => c === "wait:7")).toHaveLength(1);
  });

  it("carries on through a failing step", async () => {
    const { deps, calls } = makeDeps({
      startScan: async (mediaType: MediaType) => {
        calls.push(`scan:${mediaType}`);
        if (mediaType === "FILM") throw new Error("share unreachable");
        return { runId: 42, started: true };
      },
    });
    await expect(runSyncTick(deps)).resolves.toBeUndefined();
    expect(calls).toContain("scan:MUSIC");
    expect(calls).toContain("jellyfin");
  });

  it("carries on when waiting on a run throws", async () => {
    const { deps, calls } = makeDeps({
      waitForRun: async (runId: number) => {
        calls.push(`wait:${runId}`);
        if (runId === 1) throw new Error("database went away");
      },
    });
    await expect(runSyncTick(deps)).resolves.toBeUndefined();
    expect(calls).toContain("jellyfin");
  });
});
