// End-to-end check of the local engine's session protocol through the
// ACTUAL route handlers under /api/video/:versionId/jf/* (V4_PLAN.md phase
// 4, "Routes, clients, cut-over flag"): session -> master -> main -> every
// segment -> stop, plus the ownership check that keeps one device's
// playSessionId from reaching another device's request for the same key.
//
// This machine has no /Volumes/media mount (checked by hand, 19 Sep 2026),
// so a real film play against production data isn't reachable here; this
// test builds a synthetic MKV with a real ffmpeg into a temp MOVIES_PATH
// instead, the same fixture style engine.integration.test.ts uses (see its
// header comment for why the temp root is realpath'd). Driving the actual
// route modules -- not just engine.ts -- is what proves the HTTP contract
// end to end: URL parsing, the `kind` threaded through from each route
// family, and engine-routes.ts's ownership check all run for real here.
//
// Only the BetterAuth session lookup is mocked (auth.api.getSession),
// exactly the way require-member.test.ts avoids standing up the whole
// email-OTP flow to test what happens once a session has resolved to a
// user id; jf-viewer.ts's currentViewer() and the Prisma lookups behind it
// run for real against a temp database.
//
// Skipped where ffmpeg isn't on PATH, same gating as the other real-ffmpeg
// playback tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";
import { ffmpegPath } from "@/lib/ffmpeg-bin";

const hasFfmpeg = spawnSync(ffmpegPath(), ["-version"], { stdio: "ignore" }).status === 0;

let testPrisma: PrismaClient;
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

let root: string;
let versionId: number;
let sessionRoute: typeof import("./session/route");
let proxyRoute: typeof import("./[...path]/route");
let stopRoute: typeof import("./stop/route");
let engine: typeof import("@/lib/playback/engine");

const DURATION_SECS = 60;
const USER_A = "engine-routes-user-a";
const USER_B = "engine-routes-user-b";
const DEVICE_A = `mediavault-${USER_A}`;

/** Same recipe as engine.integration.test.ts's buildSource: a keyframe
 *  every second so the copy-tier table lands its cuts exactly on 6s
 *  boundaries -- ten segments, no fractional last one to special-case. */
function buildFilm(file: string): void {
  execFileSync(
    ffmpegPath(),
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=duration=${DURATION_SECS}:size=160x120:rate=10`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SECS}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
      "-c:a", "ac3", "-shortest",
      file,
    ],
    { stdio: "pipe" },
  );
}

function asUser(userId: string): void {
  getSession.mockResolvedValue({ user: { id: userId } });
}

describe.skipIf(!hasFfmpeg)("local-engine /jf/* routes (real ffmpeg, real handlers)", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;

    root = await realpath(await mkdtemp(path.join(tmpdir(), "mv-engine-routes-")));
    const movies = path.join(root, "movies");
    await mkdir(movies);
    process.env.MOVIES_PATH = movies;
    process.env.VIDEO_CACHE_DIR = path.join(root, "cache");
    process.env.PLAYBACK_ENGINE = "local";
    // Deliberately unset, not just left alone: PLAYBACK_ENGINE=local must
    // never need Jellyfin configured, and a stray JELLYFIN_URL from the
    // shell must not let a bug in the engine branch silently fall through
    // to a real network call.
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    delete process.env.PLAYBACK_HWACCEL;
    delete process.env.PLAYBACK_MAX_SESSIONS;
    delete process.env.JELLYFIN_MAX_SESSIONS;

    buildFilm(path.join(movies, "Test Film (2020).mkv"));

    await testPrisma.user.create({ data: { id: USER_A, name: USER_A, email: `${USER_A}@example.com` } });
    await testPrisma.user.create({ data: { id: USER_B, name: USER_B, email: `${USER_B}@example.com` } });

    const film = await testPrisma.film.create({
      data: { title: "Test Film", sortTitle: "test film", year: 2020, owned: true },
    });
    const version = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Test Film (2020).mkv",
        fileName: "Test Film (2020).mkv",
        format: "BLURAY",
        videoCodec: "h264",
        container: "mkv",
        durationSecs: DURATION_SECS,
        audioTracks: { create: [{ streamIdx: 1, codec: "ac3", channels: 1 }] },
      },
    });
    versionId = version.id;

    // Imported after the env is set, exactly like engine.integration.test.ts
    // -- the route files reach engine-flag.ts's playbackEngine() at request
    // time, not at import time, but engine.ts's own globalThis state must
    // start clean for this file's cache directory.
    sessionRoute = await import("./session/route");
    proxyRoute = await import("./[...path]/route");
    stopRoute = await import("./stop/route");
    engine = await import("@/lib/playback/engine");
  }, 120_000);

  afterAll(async () => {
    await engine?.resetEngineForTest();
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    getSession.mockReset();
  });

  it("plays a film end to end through the route handlers, and rejects another device's identity for the same session", async () => {
    asUser(USER_A);

    // 1. POST session
    const sessionRes = await sessionRoute.POST(
      new Request(`http://localhost/api/video/${versionId}/jf/session?variant=original`, { method: "POST" }),
      { params: Promise.resolve({ versionId: String(versionId) }) },
    );
    expect(sessionRes.status).toBe(200);
    const body = (await sessionRes.json()) as {
      playlistUrl: string;
      playSessionId: string;
      durationSecs: number;
      transcodeReasons: string[];
      audioTracks: { streamIdx: number; label: string }[];
    };
    expect(body.playSessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.durationSecs).toBeCloseTo(DURATION_SECS, 0);
    expect(body.audioTracks).toEqual([{ streamIdx: 1, label: expect.any(String) }]);
    const key = `film-${versionId}-original-a1`;
    const ps = body.playSessionId;
    expect(body.playlistUrl).toBe(`/api/video/${versionId}/jf/e/${key}/master.m3u8?ps=${ps}`);

    // 2. GET master.m3u8 -- points at main.m3u8 carrying the same session.
    const masterRes = await proxyRoute.GET(new Request(`http://localhost${body.playlistUrl}`), {
      params: Promise.resolve({ versionId: String(versionId), path: ["e", key, "master.m3u8"] }),
    });
    expect(masterRes.status).toBe(200);
    expect(masterRes.headers.get("Content-Type")).toBe("application/vnd.apple.mpegurl");
    expect(masterRes.headers.get("Cache-Control")).toBe("no-store");
    const master = await masterRes.text();
    const mainLine = master.trim().split("\n").at(-1) ?? "";
    expect(mainLine).toBe(`main.m3u8?ps=${ps}`);

    // 3. GET main.m3u8 -- every segment line carries the same session query.
    const mainRes = await proxyRoute.GET(new Request(`http://localhost/api/video/${versionId}/jf/e/${key}/${mainLine}`), {
      params: Promise.resolve({ versionId: String(versionId), path: ["e", key, "main.m3u8"] }),
    });
    expect(mainRes.status).toBe(200);
    expect(mainRes.headers.get("Content-Type")).toBe("application/vnd.apple.mpegurl");
    expect(mainRes.headers.get("Cache-Control")).toBe("no-store");
    const main = await mainRes.text();
    expect(main).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(main.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
    const segmentLines = main
      .split("\n")
      .filter((line) => line.startsWith("seg_"))
      .map((line) => {
        expect(line).toMatch(/^seg_\d{5}\.ts\?ps=[0-9a-f]{32}$/);
        expect(line.endsWith(`?ps=${ps}`)).toBe(true);
        return line;
      });
    // Keyframes every second, a 6s target, 60s film: exactly ten segments.
    expect(segmentLines).toHaveLength(10);

    // 4. Every URI the playlists reference actually resolves -- fetch every
    // segment in order, as a player would.
    for (const line of segmentLines) {
      const [file] = line.split("?");
      const res = await proxyRoute.GET(new Request(`http://localhost/api/video/${versionId}/jf/e/${key}/${line}`), {
        params: Promise.resolve({ versionId: String(versionId), path: ["e", key, file] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("video/mp2t");
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }

    // 5. The route's own versionId must match the key's -- a URL for a
    // different film must not reach this key even with a valid session.
    const wrongIdRes = await proxyRoute.GET(new Request(`http://localhost/api/video/${versionId + 1}/jf/e/${key}/${mainLine}`), {
      params: Promise.resolve({ versionId: String(versionId + 1), path: ["e", key, "main.m3u8"] }),
    });
    expect(wrongIdRes.status).toBe(404);

    // 6. A second device's own authenticated identity must not unlock the
    // first device's playSessionId, even for the exact key it belongs to.
    asUser(USER_B);
    const crossRes = await proxyRoute.GET(new Request(`http://localhost/api/video/${versionId}/jf/e/${key}/${mainLine}`), {
      params: Promise.resolve({ versionId: String(versionId), path: ["e", key, "main.m3u8"] }),
    });
    expect([403, 404]).toContain(crossRes.status);

    // 7. POST stop, as the owning device -- 204, and the session no longer
    // resolves for anyone afterwards.
    asUser(USER_A);
    const stopRes = await stopRoute.POST(
      new Request(`http://localhost/api/video/${versionId}/jf/stop?playSessionId=${ps}`, { method: "POST" }),
    );
    expect(stopRes.status).toBe(204);
    expect(engine.sessionBelongsTo(ps, DEVICE_A)).toBe(false);
  }, 60_000);
});
