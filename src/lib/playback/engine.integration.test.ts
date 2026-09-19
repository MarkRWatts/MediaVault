// Drives the whole v4 engine against a real ffmpeg and a real temp
// database: sessions, playlists, heads started at 0 and at a cold seek,
// concurrent requests for one missing segment, the `.complete` short
// circuit, stopping a running head, and invalidation when the source
// changes. Pins the claims V4_PLAN.md's "Heads" section stakes the design on
// and that no unit test can reach, because every one of them is about what a
// real ffmpeg actually produces.
//
// The central assertion throughout is timestamps: a segment the engine
// serves must hold the piece of film the table says it does, whether it was
// written by a head that ran from 0 or one restarted at a seek.
//
// Two forms of that assertion, because of a measured quirk. Every segment
// *except a head's own first file* carries exact absolute source
// timestamps: with -copyts and mpegts_copyts=1 (head-args.ts), segment 5 of
// a 6s table starts at 30.000000 on the nose. A head's FIRST file is
// shifted by a small constant the mpegts muxer picks for itself -- 0.023s
// with AAC, 0.200s with AC-3, measured 19 Sep 2026 -- which is also why
// decisions.ts's checkSegmentDuration cannot simply read that line's start.
// So each segment is checked both against the absolute table time (tight)
// and relative to segment 0 as a player experiences it (loose enough for
// that one offset).
//
// Skipped where ffmpeg isn't on PATH, same gating as
// video-cache.integration.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";
import { ffmpegPath, ffprobePath } from "@/lib/ffmpeg-bin";
import { KEEP_BEHIND_SEGMENTS } from "./decisions";
import { parseSegmentFileName, segmentFileName } from "./stream-key";

const hasFfmpeg = spawnSync(ffmpegPath(), ["-version"], { stdio: "ignore" }).status === 0;

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let engine: typeof import("./engine");
let source: typeof import("./source");
let root: string;
let cacheRoot: string;
let mainVersionId: number;
let longVersionId: number;
let mainFile: string;

const DEVICE = "mediavault-test-device";
/** The main fixture: 60s, tiny, H.264 with a keyframe every second, AC-3
 *  audio. Both streams are copyable, so the Original variant is the copy
 *  tier -- the case almost every real play in this library takes. */
const DURATION_SECS = 60;
/** A second fixture long enough that a head runs past the run-ahead
 *  throttle's pause watermark (30 segments) while a viewer sits on segment
 *  0. That makes "is a head still running?" deterministic rather than a race
 *  against how fast this machine encodes. */
const LONG_DURATION_SECS = 400;
/** How far the trim test moves the clock on before running housekeeping.
 *  Walking a viewer through forty segments takes this suite a second, so
 *  without it every request is still "recent" and the playhead is still at
 *  0. Two minutes is past both of the trim pass's request windows (30s and
 *  60s) and still inside the three-minute window that decides whether a
 *  session is live at all -- a viewer four minutes into a film, in other
 *  words, which is the case that fills the disk in production. */
const PLAYED_LONG_AGO_MS = 2 * 60_000;

function buildSource(file: string, durationSecs: number): void {
  execFileSync(
    ffmpegPath(),
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=duration=${durationSecs}:size=160x120:rate=10`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSecs}`,
      // A keyframe every second (rate 10, -g 10) with no scene-cut
      // keyframes, so the copy tier's keyframe-derived table lands its cuts
      // exactly on 6s boundaries and the arithmetic below is exact.
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
      "-c:a", "ac3", "-shortest",
      file,
    ],
    { stdio: "pipe" },
  );
}

interface FirstPacket {
  isKeyframe: boolean;
  pts: number;
}

function firstVideoPacket(file: string): FirstPacket {
  const out = execFileSync(
    ffprobePath(),
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0",
      "-read_intervals", "%+#1", file,
    ],
    { encoding: "utf8" },
  );
  const [pts, flags] = out.trim().split("\n")[0].split(",");
  return { isKeyframe: (flags ?? "").includes("K"), pts: Number(pts) };
}

/** Put a stream directory back to a chosen set of segments and forget
 *  everything the engine knows, so the next request is genuinely cold. */
async function keepOnlySegments(key: string, keep: number[]): Promise<void> {
  await engine.resetEngineForTest();
  const dir = path.join(cacheRoot, key);
  for (const name of await readdir(dir)) {
    const index = parseSegmentFileName(name);
    if (name === ".complete" || (index !== null && !keep.includes(index))) {
      await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

async function waitForNoLiveHeads(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (engine.engineStats().liveHeads === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("heads were still running");
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** The two forms of "this segment holds what the table says" -- see the file
 *  header for why segment 0 is the loose one. */
function expectSegmentAt(file: string, expectedStart: number, base: FirstPacket, baseStart: number): void {
  const packet = firstVideoPacket(file);
  expect(packet.isKeyframe).toBe(true);
  expect(packet.pts).toBeCloseTo(expectedStart, 3);
  expect(packet.pts - base.pts).toBeCloseTo(expectedStart - baseStart, 0);
}

describe.skipIf(!hasFfmpeg)("playback engine (real ffmpeg)", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;

    // Canonical, not as mkdtemp returns it: on a Mac the temp root is
    // /var/folders/..., and /var is a symlink to /private/var. That resolves
    // fine for a local ffmpeg and not at all for one running in a container
    // with /private bind-mounted, which is how this suite is also run
    // against the production jellyfin-ffmpeg build.
    root = await realpath(await mkdtemp(path.join(tmpdir(), "mv-playback-engine-")));
    const movies = path.join(root, "movies");
    await mkdir(movies);
    cacheRoot = path.join(root, "cache");
    process.env.MOVIES_PATH = movies;
    process.env.VIDEO_CACHE_DIR = cacheRoot;
    delete process.env.VIDEO_CACHE_MAX_BYTES;
    delete process.env.PLAYBACK_HWACCEL;
    delete process.env.PLAYBACK_MAX_SESSIONS;
    delete process.env.JELLYFIN_MAX_SESSIONS;

    mainFile = path.join(movies, "Test Film (2020).mkv");
    buildSource(mainFile, DURATION_SECS);
    buildSource(path.join(movies, "Long Film (2020).mkv"), LONG_DURATION_SECS);

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
    mainVersionId = version.id;
    const long = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Long Film (2020).mkv",
        fileName: "Long Film (2020).mkv",
        format: "BLURAY",
        videoCodec: "h264",
        container: "mkv",
        durationSecs: LONG_DURATION_SECS,
      },
    });
    longVersionId = long.id;

    engine = await import("./engine");
    source = await import("./source");
  }, 120_000);

  afterAll(async () => {
    await engine?.resetEngineForTest();
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  let key: string;

  it("starts a session with a complete VOD playlist for the whole runtime", async () => {
    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    key = session.key;

    expect(session.playSessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(session.key).toBe(`film-${mainVersionId}-original-a1`);
    expect(session.durationSecs).toBeCloseTo(DURATION_SECS, 0);
    expect(session.transcodeReasons).toContain("ContainerNotSupported");
    expect(session.audioTracks).toHaveLength(1);
    expect(session.audioTracks[0].streamIdx).toBe(1);

    const table = await engine.getSegmentTable(key);
    const main = await engine.getMainPlaylist(key);
    const extinfs = [...main.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));

    // Complete from the first request -- no sliding window, no waiting for
    // an encoder (V4_PLAN.md, "Why the first local pipeline was parked").
    expect(main).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(main.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(extinfs).toHaveLength(table.length);
    expect(extinfs.reduce((a, b) => a + b, 0)).toBeCloseTo(session.durationSecs, 1);
    // Keyframes every second and a 6s target: exactly ten 6s segments.
    expect(table).toHaveLength(10);
    expect(table[7].start).toBeCloseTo(42, 3);

    const master = await engine.getMasterPlaylist(key);
    expect(master).toContain("RESOLUTION=160x120");
    expect(master).toContain('CODECS="avc1.640028,ac-3"');
    expect(master.trim().endsWith("main.m3u8")).toBe(true);
  }, 30_000);

  it("produces segment 0 and later segments whose timestamps match the table", async () => {
    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    const table = await engine.getSegmentTable(key);

    const seg0 = await engine.getSegment(key, 0, session.playSessionId);
    expect(await exists(seg0)).toBe(true);
    const base = firstVideoPacket(seg0);
    expect(base.isKeyframe).toBe(true);

    // The head started at 0 runs on; segment 2 is whatever it wrote next.
    const seg2 = await engine.getSegment(key, 2, session.playSessionId);
    expectSegmentAt(seg2, table[2].start, base, table[0].start);
  }, 40_000);

  it("starts a new head for a cold far seek, and lands it on the right frame", async () => {
    const table = await engine.getSegmentTable(key);
    const seg0 = path.join(cacheRoot, key, "seg_00000.ts");
    const base = firstVideoPacket(seg0);

    await keepOnlySegments(key, [0]);
    const before = engine.engineStats().headsStarted;

    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    const seg7 = await engine.getSegment(key, 7, session.playSessionId);

    expect(engine.engineStats().headsStarted).toBe(before + 1);
    expectSegmentAt(seg7, table[7].start, base, table[0].start);

    // ...and a segment in between, which no head has written, is correct
    // too: a head restarted at 3 produces the same content as one that ran
    // straight through.
    await waitForNoLiveHeads();
    const seg3 = await engine.getSegment(key, 3, session.playSessionId);
    expectSegmentAt(seg3, table[3].start, base, table[0].start);
  }, 40_000);

  it("starts exactly one head for two concurrent requests for the same missing segment", async () => {
    await keepOnlySegments(key, [0]);
    const before = engine.engineStats().headsStarted;
    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });

    const [a, b] = await Promise.all([
      engine.getSegment(key, 5, session.playSessionId),
      engine.getSegment(key, 5, session.playSessionId),
    ]);

    expect(a).toBe(b);
    expect(await exists(a)).toBe(true);
    expect(engine.engineStats().headsStarted).toBe(before + 1);
  }, 40_000);

  it("marks a fully populated directory complete and never runs ffmpeg for it again", async () => {
    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    const table = await engine.getSegmentTable(key);
    for (let i = 0; i < table.length; i++) {
      await engine.getSegment(key, i, session.playSessionId);
    }
    await waitForNoLiveHeads();

    expect(await exists(path.join(cacheRoot, key, ".complete"))).toBe(true);
    expect(engine.engineStats().liveHeads).toBe(0);

    // The point of making segments deterministic per key: a resume
    // tomorrow, a second viewer or a replay needs no ffmpeg at all.
    const before = engine.engineStats().headsStarted;
    const fresh = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    for (const index of [0, 4, 9]) {
      expect(await exists(await engine.getSegment(key, index, fresh.playSessionId))).toBe(true);
    }
    expect(engine.engineStats().headsStarted).toBe(before);
  }, 60_000);

  it("stops a running head promptly and leaves no staging directory behind", async () => {
    await engine.resetEngineForTest();
    const session = await engine.startSession({
      kind: "film",
      id: longVersionId,
      variant: "remote",
      deviceId: DEVICE,
    });
    await engine.getSegment(session.key, 0, session.playSessionId);

    // The viewer is sitting on segment 0 of a 400s film, so the head runs
    // past the throttle's pause watermark and stays there -- a head that is
    // definitely still alive when we stop it, without racing the encoder.
    // (Under the docker ffmpeg shim SIGSTOP is not proxied into the
    // container, so the head keeps encoding; the engine still records it as
    // paused, and it may instead reach the end of the file. Either way what
    // is asserted below -- a prompt stop and no debris -- holds.)
    await waitFor(
      () => engine.engineStats().pausedHeads === 1 || engine.engineStats().liveHeads === 0,
      "the head to be throttled",
    );

    // Heads yield to the web app sharing the box (head.ts, HEAD_NICE). Only
    // checkable when ffmpeg is a direct child: under the docker shim the
    // child is `docker run`, and niceness doesn't cross into the container.
    if (engine.engineStats().liveHeads === 1 && !/jfbin|docker/.test(process.env.FFMPEG_PATH ?? "")) {
      const ni = execFileSync("ps", ["-A", "-o", "ni=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes("seg_%05d.ts") && l.includes(process.env.VIDEO_CACHE_DIR!))
        .map((l) => Number(l.trim().split(/\s+/)[0]));
      expect(ni).toEqual([10]);
    }

    const startedAt = Date.now();
    await engine.stopSession(session.playSessionId);
    const elapsed = Date.now() - startedAt;

    // Measured 19 Sep 2026: 7ms against a local ffmpeg, 199ms with the
    // binary behind a `docker run` shim (SIGTERM is proxied to the
    // container's PID 1; SIGSTOP and SIGCONT are not, so the head above
    // keeps encoding past the pause watermark under the shim).
    expect(elapsed).toBeLessThan(2_500);
    expect(engine.engineStats().liveHeads).toBe(0);
    const leftovers = (await readdir(path.join(cacheRoot, session.key))).filter((n) => n.startsWith(".part-"));
    expect(leftovers).toEqual([]);
  }, 60_000);

  it("cuts a transcoded remote rendition on the table's boundaries, cold seek included", async () => {
    await engine.resetEngineForTest();
    const first = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "remote",
      deviceId: DEVICE,
    });
    const remoteKey = first.key;
    const table = await engine.getSegmentTable(remoteKey);
    // Transcoded video is cut on a fixed grid, not on source keyframes.
    expect(table[5].start).toBeCloseTo(30, 6);

    const base = firstVideoPacket(await engine.getSegment(remoteKey, 0, first.playSessionId));
    await keepOnlySegments(remoteKey, [0]);

    const second = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "remote",
      deviceId: DEVICE,
    });
    const seg5 = await engine.getSegment(remoteKey, 5, second.playSessionId);
    expectSegmentAt(seg5, table[5].start, base, table[0].start);
  }, 60_000);

  it("discards the cached segments when the source file changes", async () => {
    await engine.resetEngineForTest();
    source.clearProbeCacheForTest();
    expect(await exists(path.join(cacheRoot, key, "seg_00000.ts"))).toBe(true);

    const when = new Date(Date.now() + 60_000);
    await utimes(mainFile, when, when);

    await engine.startSession({ kind: "film", id: mainVersionId, variant: "original", deviceId: DEVICE });
    // Same key, same table -- but plan.json's recorded mtime no longer
    // matches the file, so every segment in there was cut from something
    // else and none of it may be mixed with what comes next.
    expect(await exists(path.join(cacheRoot, key, "seg_00000.ts"))).toBe(false);
    expect(await exists(path.join(cacheRoot, key, ".complete"))).toBe(false);
    expect(await exists(path.join(cacheRoot, key, "plan.json"))).toBe(true);
  }, 30_000);

  it("verified every segment it published against the table", async () => {
    // The safety net for a missed cut (decisions.ts's checkSegmentDuration):
    // a single mismatch anywhere above would mean a head published a segment
    // holding the wrong six seconds of film.
    const stats = engine.engineStats();
    expect(stats.segmentMismatches).toBe(0);
    expect(stats.segmentsVerified).toBeGreaterThan(20);
  });

  it("scopes sessionBelongsTo to the session's own device and stream key", async () => {
    // The local-engine routes' whole ownership check (engine-routes.ts's
    // checkEngineAccess) rests on this: a session must not be usable by a
    // request that names a different device, and a stream key request must
    // not be honoured for a session that started against a different one.
    await engine.resetEngineForTest();
    const session = await engine.startSession({
      kind: "film",
      id: mainVersionId,
      variant: "original",
      deviceId: DEVICE,
    });

    expect(engine.sessionBelongsTo(session.playSessionId, DEVICE)).toBe(true);
    expect(engine.sessionBelongsTo(session.playSessionId, DEVICE, session.key)).toBe(true);
    expect(engine.sessionBelongsTo(session.playSessionId, "some-other-device")).toBe(false);
    expect(engine.sessionBelongsTo(session.playSessionId, DEVICE, "film-999999-original-a1")).toBe(false);
    expect(engine.sessionBelongsTo("0".repeat(32), DEVICE)).toBe(false);

    await engine.stopSession(session.playSessionId);
    expect(engine.sessionBelongsTo(session.playSessionId, DEVICE)).toBe(false);
  }, 30_000);

  it("lets one viewer hold two streams, replaces the stalest for a third, and honours `replaces`", async () => {
    const start = (deviceId: string, replaces?: string) =>
      engine.startSession({ kind: "film", id: mainVersionId, variant: "original", deviceId, replaces });
    // A clean slate: earlier tests' sessions for DEVICE are still on the books.
    const prevMax = process.env.PLAYBACK_MAX_SESSIONS;
    process.env.PLAYBACK_MAX_SESSIONS = "3";
    try {
      const me = "device-two-streams";
      const a = await start(me);
      await new Promise((r) => setTimeout(r, 5));
      const b = await start(me);
      // Phone and laptop: both stay valid.
      expect(engine.sessionBelongsTo(a.playSessionId, me)).toBe(true);
      expect(engine.sessionBelongsTo(b.playSessionId, me)).toBe(true);

      // A quality switch on one of them names what it replaces: that one
      // goes, the other device is untouched.
      const b2 = await start(me, b.playSessionId);
      expect(engine.sessionBelongsTo(b.playSessionId, me)).toBe(false);
      expect(engine.sessionBelongsTo(a.playSessionId, me)).toBe(true);
      expect(engine.sessionBelongsTo(b2.playSessionId, me)).toBe(true);

      // A third stream with no hint: the viewer's stalest goes, not the newest.
      engine.touchSession(b2.playSessionId);
      const c = await start(me);
      expect(engine.sessionBelongsTo(a.playSessionId, me)).toBe(false);
      expect(engine.sessionBelongsTo(b2.playSessionId, me)).toBe(true);
      expect(engine.sessionBelongsTo(c.playSessionId, me)).toBe(true);

      // `replaces` is a hint, not a credential: someone else's id is ignored.
      const other = await start("device-someone-else", c.playSessionId);
      expect(engine.sessionBelongsTo(c.playSessionId, me)).toBe(true);

      // The global cap counts streams, whoever holds them: 2 + 1 = 3 = max.
      await expect(start("device-one-too-many")).rejects.toMatchObject({ code: "session-cap" });

      for (const id of [b2.playSessionId, c.playSessionId, other.playSessionId]) await engine.stopSession(id);
    } finally {
      if (prevMax === undefined) delete process.env.PLAYBACK_MAX_SESSIONS;
      else process.env.PLAYBACK_MAX_SESSIONS = prevMax;
    }
  });

  it("falls back to software when the configured hardware encoder isn't there", async () => {
    // This Mac has no render node. V4_PLAN.md is explicit that a missing or
    // misconfigured device degrades playback rather than breaking it.
    const hwaccel = await import("./hwaccel");
    hwaccel.resetHwAccelForTest();
    process.env.PLAYBACK_HWACCEL = "vaapi";
    try {
      expect(await hwaccel.resolveHwAccel()).toBe("none");
      const status = hwaccel.hwAccelStatus();
      expect(status.configured).toBe("vaapi");
      expect(status.effective).toBe("none");
      expect(status.reason).toBeTruthy();
    } finally {
      delete process.env.PLAYBACK_HWACCEL;
      hwaccel.resetHwAccelForTest();
    }
  }, 30_000);


  // The production failure this one exists for (19 Sep 2026): a Blu-ray
  // remux is ~25 MB per 6s segment, the stream being watched is pinned
  // against whole-stream eviction, and nothing removed what the viewer had
  // already played -- so ~35 minutes in, free disk fell under
  // MIN_FREE_DISK_BYTES and the engine refused to start heads. Here the same
  // pressure is made with a tiny VIDEO_CACHE_MAX_BYTES over the long fixture.
  it("trims what the viewer has played under pressure, and refills it on a seek back", async () => {
    await engine.resetEngineForTest();
    const first = await engine.startSession({
      kind: "film",
      id: longVersionId,
      variant: "original",
      deviceId: DEVICE,
    });
    const longKey = first.key;
    const table = await engine.getSegmentTable(longKey);
    const segPath = (index: number) => path.join(cacheRoot, longKey, segmentFileName(index));
    const marker = (name: string) => path.join(cacheRoot, longKey, name);
    expect(table.length).toBeGreaterThan(KEEP_BEHIND_SEGMENTS * 2);

    // With pressure off, nothing is trimmed and the stream reaches
    // `.complete` -- the property V4_PLAN.md is proud of, and the reason
    // trimming is a pressure response rather than a policy.
    for (let i = 0; i < table.length; i++) await engine.getSegment(longKey, i, first.playSessionId);
    await waitForNoLiveHeads();
    expect(await exists(marker(".complete"))).toBe(true);
    await engine.runHousekeepingForTest(Date.now() + PLAYED_LONG_AGO_MS);
    expect(await exists(marker(".complete"))).toBe(true);
    expect(await exists(segPath(0))).toBe(true);

    const base = firstVideoPacket(segPath(0));
    await engine.stopSession(first.playSessionId);

    const prevMax = process.env.VIDEO_CACHE_MAX_BYTES;
    process.env.VIDEO_CACHE_MAX_BYTES = "65536";
    try {
      const viewer = await engine.startSession({
        kind: "film",
        id: longVersionId,
        variant: "original",
        deviceId: DEVICE,
      });
      const playhead = 40;
      for (let i = 0; i <= playhead; i++) await engine.getSegment(longKey, i, viewer.playSessionId);

      // Nothing goes while every request is recent -- the engine has just
      // handed these paths out and a response may be opening one of them.
      await engine.runHousekeepingForTest();
      expect(await exists(segPath(0))).toBe(true);
      expect(await exists(segPath(playhead))).toBe(true);

      // Two minutes on (still well inside the live window, well past both
      // request windows) the viewer is four minutes into the film: what is
      // further behind than the rewind window goes, and nothing from it
      // onward does -- least of all the segment just served.
      await engine.runHousekeepingForTest(Date.now() + PLAYED_LONG_AGO_MS);
      const kept = playhead - KEEP_BEHIND_SEGMENTS;
      for (let i = 0; i < kept; i++) expect(await exists(segPath(i))).toBe(false);
      for (let i = kept; i <= playhead; i++) expect(await exists(segPath(i))).toBe(true);
      // The directory is a partial one again, cut from the same file against
      // the same table: `.complete` goes, plan.json and `.atime` stay.
      expect(await exists(marker(".complete"))).toBe(false);
      expect(await exists(marker("plan.json"))).toBe(true);
      expect(await exists(marker(".atime"))).toBe(true);

      // Seeking back into the hole is an ordinary cold request: one head
      // starts there and the segments it writes hold what the table says.
      // The second request is made after the first rather than beside it, so
      // that this asserts a waiter being answered by the running head and
      // not a race over which index the head starts at.
      const before = engine.engineStats().headsStarted;
      const seg5 = await engine.getSegment(longKey, 5, viewer.playSessionId);
      const seg8 = await engine.getSegment(longKey, 8, viewer.playSessionId);
      expect(engine.engineStats().headsStarted).toBe(before + 1);
      expectSegmentAt(seg5, table[5].start, base, table[0].start);
      expectSegmentAt(seg8, table[8].start, base, table[0].start);

      // ...and it stops as soon as it runs into what is still cached
      // (isHeadCaughtUp), rather than re-writing the rest of the film.
      await waitForNoLiveHeads();
      for (let i = 5; i < kept; i++) expect(await exists(segPath(i))).toBe(true);
      expect(await exists(segPath(0))).toBe(false);
      expect(engine.engineStats().headsStarted).toBe(before + 1);

      await engine.stopSession(viewer.playSessionId);
    } finally {
      if (prevMax === undefined) delete process.env.VIDEO_CACHE_MAX_BYTES;
      else process.env.VIDEO_CACHE_MAX_BYTES = prevMax;
    }

    expect(engine.engineStats().segmentMismatches).toBe(0);
  }, 90_000);
});
