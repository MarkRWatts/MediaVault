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
let mp4VersionId: number;
let uhdVersionId: number;
let staleVersionId: number;
let episodeFileId: number;
let sessionRoute: typeof import("./session/route");
let filmStreamRoute: typeof import("../stream/route");
let tvSessionRoute: typeof import("@/app/api/tv-video/[episodeFileId]/jf/session/route");
let tvStreamRoute: typeof import("@/app/api/tv-video/[episodeFileId]/stream/route");
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

/** The library's own format since Sep 2026: H.264 + AAC in a faststart
 *  MP4 -- what the session route may hand back as the file itself. */
function buildDirectPlayable(file: string): void {
  execFileSync(
    ffmpegPath(),
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=duration=${DURATION_SECS}:size=160x120:rate=10`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SECS}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "10",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
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
    buildDirectPlayable(path.join(movies, "Direct Film (2021).mp4"));
    // Stands in for a 4K rip: what matters to the routes is the format.
    buildDirectPlayable(path.join(movies, "UHD Film (2022).mp4"));
    buildDirectPlayable(path.join(movies, "Remuxed Film (2023).mp4"));
    const tv = path.join(root, "tv");
    await mkdir(path.join(tv, "Test Show (2010)", "Season 01"), { recursive: true });
    process.env.TVSHOWS_PATH = tv;
    buildDirectPlayable(path.join(tv, "Test Show (2010)", "Season 01", "Test Show S01E01.mp4"));

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

    const mp4Film = await testPrisma.film.create({
      data: { title: "Direct Film", sortTitle: "direct film", year: 2021, owned: true },
    });
    const mp4Version = await testPrisma.version.create({
      data: {
        filmId: mp4Film.id,
        filePath: "Direct Film (2021).mp4",
        fileName: "Direct Film (2021).mp4",
        format: "BLURAY",
        videoCodec: "h264",
        container: "mp4",
        durationSecs: DURATION_SECS,
        audioTracks: { create: [{ streamIdx: 1, codec: "aac", channels: 1, isDefault: true }] },
      },
    });
    mp4VersionId = mp4Version.id;

    const uhdFilm = await testPrisma.film.create({
      data: { title: "UHD Film", sortTitle: "uhd film", year: 2022, owned: true },
    });
    const uhdVersion = await testPrisma.version.create({
      data: {
        filmId: uhdFilm.id,
        filePath: "UHD Film (2022).mp4",
        fileName: "UHD Film (2022).mp4",
        format: "UHD",
        videoCodec: "h264",
        container: "mp4",
        durationSecs: DURATION_SECS,
        audioTracks: { create: [{ streamIdx: 1, codec: "aac", channels: 1, isDefault: true }] },
      },
    });
    uhdVersionId = uhdVersion.id;

    // Remuxed on the share since the last scan: the row still lists the
    // TrueHD + AC-3 the file used to have; the file is H.264 + AAC now.
    const staleFilm = await testPrisma.film.create({
      data: { title: "Remuxed Film", sortTitle: "remuxed film", year: 2023, owned: true },
    });
    const staleVersion = await testPrisma.version.create({
      data: {
        filmId: staleFilm.id,
        filePath: "Remuxed Film (2023).mp4",
        fileName: "Remuxed Film (2023).mp4",
        format: "UHD",
        videoCodec: "h264",
        container: "mp4",
        durationSecs: DURATION_SECS,
        audioTracks: {
          create: [
            { streamIdx: 1, codec: "truehd", channels: 8, isDefault: true },
            { streamIdx: 2, codec: "ac3", channels: 6 },
          ],
        },
      },
    });
    staleVersionId = staleVersion.id;

    const show = await testPrisma.show.create({ data: { title: "Test Show", sortTitle: "test show", folder: "Test Show (2010)" } });
    const season = await testPrisma.showSeason.create({ data: { showId: show.id, seasonNumber: 1 } });
    const episode = await testPrisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, owned: true } });
    const episodeFile = await testPrisma.episodeFile.create({
      data: {
        episodeId: episode.id,
        filePath: "Test Show (2010)/Season 01/Test Show S01E01.mp4",
        fileName: "Test Show S01E01.mp4",
        videoCodec: "h264",
        container: "mp4",
        durationSecs: DURATION_SECS,
      },
    });
    episodeFileId = episodeFile.id;

    // The /stream routes gate on household membership, not just a session.
    const household = await testPrisma.household.create({
      data: { id: "engine-routes-household", name: "h", slug: "engine-routes-household", createdAt: new Date() },
    });
    await testPrisma.member.create({
      data: { id: `${USER_A}-member`, householdId: household.id, userId: USER_A, createdAt: new Date() },
    });

    // Imported after the env is set, exactly like engine.integration.test.ts
    // -- the route files reach engine-flag.ts's playbackEngine() at request
    // time, not at import time, but engine.ts's own globalThis state must
    // start clean for this file's cache directory.
    sessionRoute = await import("./session/route");
    filmStreamRoute = await import("../stream/route");
    tvSessionRoute = await import("@/app/api/tv-video/[episodeFileId]/jf/session/route");
    tvStreamRoute = await import("@/app/api/tv-video/[episodeFileId]/stream/route");
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

  // UHD_PLAN.md phase B, "Direct-play routing".
  async function filmSession(id: number, query: string) {
    const res = await sessionRoute.POST(new Request(`http://localhost/api/video/${id}/jf/session?${query}`, { method: "POST" }), {
      params: Promise.resolve({ versionId: String(id) }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { mode: string; playlistUrl: string; playSessionId: string | null; durationSecs: number; audioTracks: unknown[] };
  }

  async function filmProxy(id: number, pathParts: string[], ps: string | null) {
    return proxyRoute.GET(new Request(`http://localhost/api/video/${id}/jf/${pathParts.join("/")}?ps=${ps}`), {
      params: Promise.resolve({ versionId: String(id), path: pathParts }),
    });
  }

  it("hands a direct-playable MP4 back as the file itself -- but only to a client that asked", async () => {
    asUser(USER_A);
    const direct = await filmSession(mp4VersionId, "variant=original&direct=1&vcodecs=h264,hevc");
    expect(direct.mode).toBe("direct");
    expect(direct.playlistUrl).toBe(`/api/video/${mp4VersionId}/stream`);
    expect(direct.playSessionId).toBeNull();
    expect(direct.durationSecs).toBeCloseTo(DURATION_SECS, 0);
    expect(direct.audioTracks).toEqual([{ streamIdx: 1, label: expect.any(String) }]);

    // Opt-in: today's iOS app never sends direct=1 and must get HLS as before.
    expect((await filmSession(mp4VersionId, "variant=original")).mode).toBe("hls");
    // Remote exists to cut the bitrate, which the file itself can't do.
    expect((await filmSession(mp4VersionId, "variant=remote&direct=1&vcodecs=h264")).mode).toBe("hls");
    // A client that can't decode the file's video.
    expect((await filmSession(mp4VersionId, "variant=original&direct=1&vcodecs=hevc")).mode).toBe("hls");
    // Asking for the default track by index is still the file as-is.
    expect((await filmSession(mp4VersionId, "variant=original&audio=1&direct=1&vcodecs=h264")).mode).toBe("direct");
    // An MKV (AC-3 audio, Matroska) needs the engine whatever the client says.
    expect((await filmSession(versionId, "variant=original&direct=1&vcodecs=h264")).mode).toBe("hls");
  }, 60_000);

  it("streams a UHD Version only with its video copied, and refuses to convert one", async () => {
    asUser(USER_A);
    // HLS, not the file itself, even though the file could be direct-played:
    // the Apple TV stalls on a direct-played UHD file (canStreamUhd).
    const copied = await filmSession(uhdVersionId, "variant=original&direct=1&vcodecs=h264,hevc");
    expect(copied.mode).toBe("hls");
    const key = /\/jf\/e\/([^/]+)\//.exec(copied.playlistUrl)?.[1] ?? "";
    expect(key).toMatch(/-original-/);
    const master = await filmProxy(uhdVersionId, ["e", key, "master.m3u8"], copied.playSessionId);
    expect(master.status).toBe(200);
    // Another rendition of it is refused even with a live session in hand.
    const remote = await filmProxy(uhdVersionId, ["e", key.replace("-original-", "-remote-"), "master.m3u8"], copied.playSessionId);
    expect(remote.status).toBe(403);

    // Anything that would need a conversion -- or a client that didn't say it
    // can decode the video -- is a 403 with the machine-readable reason.
    for (const query of ["variant=original", "variant=remote&direct=1&vcodecs=h264", "variant=original&direct=1&vcodecs=hevc"]) {
      const res = await sessionRoute.POST(
        new Request(`http://localhost/api/video/${uhdVersionId}/jf/session?${query}`, { method: "POST" }),
        { params: Promise.resolve({ versionId: String(uhdVersionId) }) },
      );
      expect(res.status, query).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "uhd_playback_disabled" });
    }

    const stream = await filmStreamRoute.GET(
      new Request(`http://localhost/api/video/${uhdVersionId}/stream`, { headers: { Range: "bytes=0-99" } }),
      { params: Promise.resolve({ versionId: String(uhdVersionId) }) },
    );
    expect(stream.status).toBe(206);
  }, 60_000);

  it("judges /stream by the file, not a library row a remux has left behind", async () => {
    asUser(USER_A);
    // The row's TrueHD would need converting; the file's AAC copies. A UHD
    // Version streams as copied HLS, so a session at all means the file won.
    expect((await filmSession(staleVersionId, "variant=original&direct=1&vcodecs=h264,hevc")).mode).toBe("hls");
    const res = await filmStreamRoute.GET(
      new Request(`http://localhost/api/video/${staleVersionId}/stream`, { headers: { Range: "bytes=0-99" } }),
      { params: Promise.resolve({ versionId: String(staleVersionId) }) },
    );
    expect(res.status).toBe(206);
  }, 60_000);

  it("serves the direct-play file with byte ranges, and refuses a file that needs the engine", async () => {
    asUser(USER_A);
    const res = await filmStreamRoute.GET(
      new Request(`http://localhost/api/video/${mp4VersionId}/stream`, { headers: { Range: "bytes=0-99" } }),
      { params: Promise.resolve({ versionId: String(mp4VersionId) }) },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect((await res.arrayBuffer()).byteLength).toBe(100);

    const mkv = await filmStreamRoute.GET(new Request(`http://localhost/api/video/${versionId}/stream`), {
      params: Promise.resolve({ versionId: String(versionId) }),
    });
    expect(mkv.status).toBe(409);
  });

  it("does the same for an episode: direct session, then the new episode /stream route", async () => {
    asUser(USER_A);
    const sessionRes = await tvSessionRoute.POST(
      new Request(`http://localhost/api/tv-video/${episodeFileId}/jf/session?variant=original&direct=1&vcodecs=h264`, { method: "POST" }),
      { params: Promise.resolve({ episodeFileId: String(episodeFileId) }) },
    );
    expect(sessionRes.status).toBe(200);
    const body = (await sessionRes.json()) as { mode: string; playlistUrl: string };
    expect(body.mode).toBe("direct");
    expect(body.playlistUrl).toBe(`/api/tv-video/${episodeFileId}/stream`);

    const res = await tvStreamRoute.GET(
      new Request(`http://localhost/api/tv-video/${episodeFileId}/stream`, { headers: { Range: "bytes=10-19" } }),
      { params: Promise.resolve({ episodeFileId: String(episodeFileId) }) },
    );
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(10);

    // Membership is enforced: no session, no bytes.
    getSession.mockResolvedValue(null);
    const anon = await tvStreamRoute.GET(new Request(`http://localhost/api/tv-video/${episodeFileId}/stream`), {
      params: Promise.resolve({ episodeFileId: String(episodeFileId) }),
    });
    expect(anon.status).toBe(401);
  });
});
