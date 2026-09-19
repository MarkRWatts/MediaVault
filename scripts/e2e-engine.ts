// End-to-end check of the v4 local playback engine (V4_PLAN.md) against a
// real browser: a throwaway SQLite database, two synthetic films under a
// scratch MOVIES_PATH, a `next dev` it starts itself with
// PLAYBACK_ENGINE=local and no JELLYFIN_* env at all, a scratch
// VIDEO_CACHE_DIR, seeded sign-in, and a Chromium-family browser driven by
// Playwright. This is scripts/e2e-playback.ts's sibling for the NEW engine
// (that script still tests the OLD, parked event-playlist pipeline behind
// IN_APP_PLAYBACK=1 -- see its own header and V4_PLAN.md's "Why the first
// local pipeline was parked"): same shape (throwaway DB, synthetic sources,
// its own `next dev`, Playwright), different pipeline, and the things worth
// proving are different too -- seek-anywhere on a real VOD playlist rather
// than "does the growing event playlist keep up".
//
// Usage (from the repo root):
//
//   npx tsx scripts/e2e-engine.ts
//
// Env: E2E_PORT (default 3009); E2E_CHROMIUM to point at a browser binary.
// Chrome has no native HLS, so VideoPlayer takes its hls.js path regardless
// of platform -- see preferNativeHls in src/components/VideoPlayer.tsx, which
// only ever prefers native HLS on Apple's own WebKit. On a Mac:
//   E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//
// Audio codec note: the synthetic films use AAC, not AC-3, even though most
// of the real library carries AC-3 and the app happily copies it. Measured
// against this Chrome build (MediaSource.isTypeSupported): AC-3/E-AC-3 in
// MSE is unsupported on macOS, exactly the limitation e2e-playback.ts's seed()
// already documents for the same reason. AAC is in COMPATIBLE_AUDIO_CODECS
// (video-playback.ts) same as AC-3, so Film A's Original variant is still
// copy-tier for both streams -- the substitution changes nothing the checks
// below assert, it just makes the audio audible to the test browser.
//
// This is a black-box browser test: it has no way to read the server
// process's in-memory engine state (engineStats, live heads) without adding
// a debug endpoint, which V4_PLAN.md's design explicitly keeps off the
// surface the client sees. So where the plan's own language talks about
// heads and cold starts, the checks below assert what a viewer actually
// experiences (does it play, does the position carry over, how long did it
// take) rather than internal spawn counts -- src/lib/playback/engine.integration.test.ts
// and engine-routes.integration.test.ts already pin the head-lifecycle
// internals with real assertions against engineStats(); this script's job is
// the layer above that: the actual HTTP contract through the actual routes,
// in an actual browser, end to end.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  closeSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { ffmpegPath } from "@/lib/ffmpeg-bin";
import { STREAM_KEY_RE, SEGMENT_FILE_RE } from "@/lib/playback/stream-key";

const PORT = Number(process.env.E2E_PORT ?? "3009");
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(32).toString("hex");
const USER_ID = "e2e-engine-user";
const EMAIL = "e2e-engine@example.com";

const FILM_A_DURATION = 120;
const FILM_B_DURATION = 120;

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sessionCookie(token: string): string {
  const sig = createHmac("sha256", SECRET).update(token).digest("base64");
  return encodeURIComponent(`${token}.${sig}`);
}

function ffmpeg(args: string[]): void {
  execFileSync(ffmpegPath(), ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Synthetic sources
// ---------------------------------------------------------------------------

/** Film A: H.264 + two AAC tracks in MKV, a keyframe every second (rate 10,
 *  `-g 10`, no scene-cut keyframes) so the copy tier's Cues-derived table
 *  lands its cuts on clean 6s boundaries -- same recipe
 *  engine.integration.test.ts's buildSource uses. Two audio streams (eng
 *  default, fra) exercise the player's Audio dropdown; both are copyable, so
 *  Original is copy-tier end to end. */
function buildFilmA(file: string): void {
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=duration=${FILM_A_DURATION}:size=160x120:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${FILM_A_DURATION}`,
    "-f", "lavfi", "-i", `sine=frequency=880:duration=${FILM_A_DURATION}`,
    "-map", "0:v", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "192k",
    "-metadata:s:a:0", "language=eng", "-disposition:a:0", "default",
    "-metadata:s:a:1", "language=fra", "-disposition:a:1", "0",
    "-shortest",
    file,
  ]);
}

/** Film B: MPEG-2 video (not in SUPPORTED_VIDEO_CODECS -- video-playback.ts)
 *  + AAC in MKV. Original has no choice but to transcode the video to H.264;
 *  the fixed-grid transcode-tier segment table doesn't care about source
 *  keyframes at all. */
function buildFilmB(file: string): void {
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=duration=${FILM_B_DURATION}:size=160x120:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=660:duration=${FILM_B_DURATION}`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "mpeg2video", "-qscale:v", "5",
    "-c:a", "aac", "-b:a", "192k",
    "-metadata:s:a:0", "language=eng", "-disposition:a:0", "default",
    "-shortest",
    file,
  ]);
}

// ---------------------------------------------------------------------------
// next dev
// ---------------------------------------------------------------------------

function startNextDev(dir: string, dbUrl: string, cacheDir: string): { child: ChildProcess; logPath: string } {
  const logPath = path.join(dir, "next-dev.log");
  const log = openSync(logPath, "a");
  const child = spawn("npx", ["next", "dev", "-p", String(PORT), "-H", "localhost"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE,
      ALLOWED_EMAILS: "",
      RESEND_API_KEY: "",
      MOVIES_PATH: path.join(dir, "movies"),
      TVSHOWS_PATH: "",
      MUSIC_PATH: "",
      ADULT_PATH: "",
      POSTER_CACHE_DIR: path.join(dir, "posters"),
      VIDEO_CACHE_DIR: cacheDir,
      NEXT_TELEMETRY_DISABLED: "1",
      // The v4 cut-over flag (engine-flag.ts): the local engine, never
      // Jellyfin, and no hardware (this Mac has no render node -- see
      // hwaccel.ts's self-test, which would harmlessly fall back to "none"
      // anyway, but being explicit is the point of this run).
      PLAYBACK_ENGINE: "local",
      PLAYBACK_HWACCEL: "none",
      // Every JELLYFIN_* var the codebase reads, explicitly emptied rather
      // than merely left unset -- Next's own dotenv loading would otherwise
      // repopulate them from the worktree's copied .env for anything not
      // already present in this spawn's env (see this file's header: "no
      // JELLYFIN_* env at all", to prove nothing here needs it).
      JELLYFIN_URL: "",
      JELLYFIN_API_KEY: "",
      JELLYFIN_MAX_SESSIONS: "",
      JELLYFIN_MOVIES_PREFIX: "",
      JELLYFIN_TV_PREFIX: "",
      JELLYFIN_ADULT_PREFIX: "",
      JELLYFIN_FOLDER_ID: "",
      // Native ffmpeg/ffprobe are on PATH (FFMPEG_PATH/FFPROBE_PATH unset ->
      // ffmpeg-bin.ts's defaults) -- no docker shim.
      FFPROBE_DOCKER_IMAGE: "",
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  return { child, logPath };
}

function stopNextDev(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/signin`, { redirect: "manual" });
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  throw new Error(`next dev on ${BASE} didn't become ready within 120s`);
}

// ---------------------------------------------------------------------------
// Process tree (check 7: no leftover ffmpeg children after stop)
// ---------------------------------------------------------------------------

function directChildren(pid: number): number[] {
  const res = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return (res.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

function processCommand(pid: number): string {
  const res = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

/** Every descendant of `rootPid`, BFS over the process tree via `pgrep -P`.
 *  Scoped to this test's own spawned `next dev` (and everything IT spawned,
 *  however many generations deep) rather than a blanket `pgrep ffmpeg` --
 *  this machine can have unrelated ffmpeg processes running for other work
 *  entirely, which must not make this check pass or fail on their account. */
function allDescendants(rootPid: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const kid of directChildren(pid)) {
        if (!seen.has(kid)) {
          seen.add(kid);
          next.push(kid);
        }
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

function ffmpegDescendantsOf(rootPid: number): number[] {
  return allDescendants(rootPid).filter((pid) => processCommand(pid).toLowerCase().includes("ffmpeg"));
}

// ---------------------------------------------------------------------------
// DB seed
// ---------------------------------------------------------------------------

interface Seeded {
  token: string;
  filmAId: number;
  filmAVersionId: number;
  filmBId: number;
  filmBVersionId: number;
}

async function seed(prisma: PrismaClient, movies: string): Promise<Seeded> {
  const now = new Date();
  await prisma.user.create({ data: { id: USER_ID, name: "E2E Engine Person", email: EMAIL, emailVerified: true } });
  await prisma.household.create({
    data: { id: "e2e-engine-household", name: "E2E Engine household", slug: "e2e-engine-household", createdAt: now },
  });
  await prisma.member.create({
    data: { id: "e2e-engine-member", householdId: "e2e-engine-household", userId: USER_ID, role: "owner", createdAt: now },
  });
  const token = randomBytes(24).toString("base64url");
  await prisma.session.create({
    data: {
      id: `sess-${token.slice(0, 8)}`,
      token,
      userId: USER_ID,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
    },
  });

  buildFilmA(path.join(movies, "Engine Film A (2023).mkv"));
  buildFilmB(path.join(movies, "Engine Film B (2024).mkv"));

  // No jellyfinId anywhere -- isFilePlayable() for the local engine is
  // exactly "has this been probed" (engine-flag.ts), and resolveSource()
  // (playback/source.ts) never reads it either.
  const filmA = await prisma.film.create({
    data: {
      title: "Engine Film A",
      sortTitle: "engine film a",
      year: 2023,
      owned: true,
      versions: {
        create: {
          filePath: "Engine Film A (2023).mkv",
          fileName: "Engine Film A (2023).mkv",
          format: "BLURAY",
          width: 160,
          height: 120,
          videoCodec: "h264",
          container: "mkv",
          durationSecs: FILM_A_DURATION,
          audioTracks: {
            create: [
              { streamIdx: 1, codec: "aac", language: "eng", channels: 1, isDefault: true },
              { streamIdx: 2, codec: "aac", language: "fra", channels: 1, isDefault: false },
            ],
          },
        },
      },
    },
    include: { versions: true },
  });

  const filmB = await prisma.film.create({
    data: {
      title: "Engine Film B",
      sortTitle: "engine film b",
      year: 2024,
      owned: true,
      versions: {
        create: {
          filePath: "Engine Film B (2024).mkv",
          fileName: "Engine Film B (2024).mkv",
          format: "DVD",
          width: 160,
          height: 120,
          videoCodec: "mpeg2video",
          container: "mkv",
          durationSecs: FILM_B_DURATION,
          audioTracks: { create: [{ streamIdx: 1, codec: "aac", language: "eng", channels: 1, isDefault: true }] },
        },
      },
    },
    include: { versions: true },
  });

  return {
    token,
    filmAId: filmA.id,
    filmAVersionId: filmA.versions[0].id,
    filmBId: filmB.id,
    filmBVersionId: filmB.versions[0].id,
  };
}

async function newContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE });
  await context.addCookies([
    { name: "better-auth.session_token", value: sessionCookie(token), domain: "localhost", path: "/" },
  ]);
  return context;
}

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------

interface VideoState {
  t: number;
  readyState: number;
  paused: boolean;
  duration: number;
  seekableEnd: number;
}

async function sampleVideo(page: Page): Promise<VideoState | null> {
  return page.evaluate(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (!v) return null;
    return {
      t: v.currentTime,
      readyState: v.readyState,
      paused: v.paused,
      duration: v.duration,
      seekableEnd: v.seekable.length > 0 ? v.seekable.end(0) : -1,
    };
  });
}

/** Polls until the video is genuinely playing past `minTime` with real data
 *  available (readyState >= HAVE_FUTURE_DATA), or the timeout runs out. */
async function waitForPlayable(page: Page, minTime: number, timeoutMs: number): Promise<VideoState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sampleVideo(page);
    if (s && s.t > minTime && s.readyState >= 3) return s;
    await sleep(200);
  }
  return null;
}

async function waitForTimeAbove(page: Page, secs: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let t = -1;
  while (Date.now() < deadline) {
    const s = await sampleVideo(page);
    t = s?.t ?? -1;
    if (t > secs) return t;
    await sleep(200);
  }
  return t;
}

async function seekTo(page: Page, secs: number): Promise<void> {
  await page.evaluate((target) => {
    const v = document.querySelector("video") as HTMLVideoElement;
    v.currentTime = target;
  }, secs);
}

/** playlistUrl looks like "/api/video/12/jf/e/film-12-remote-a2/master.m3u8?ps=...".
 *  Pulls the stream key out of it -- see stream-key.ts's format. */
function keyFromPlaylistUrl(playlistUrl: string): string | null {
  const m = /\/jf\/e\/([^/]+)\/master\.m3u8/.exec(playlistUrl);
  return m ? m[1] : null;
}

interface TrafficEntry {
  url: string;
  method: string;
  status: number;
}

function recordTraffic(page: Page): TrafficEntry[] {
  const entries: TrafficEntry[] = [];
  page.on("response", (res) => {
    entries.push({ url: res.url(), method: res.request().method(), status: res.status() });
  });
  return entries;
}

/** Checks 4: every playlist/segment response came from this film's own
 *  /jf/e/... path with a 2xx byte-serving status, and nothing -- of any kind
 *  -- left this origin. Run against the traffic recorded for one player
 *  session (or a whole context's worth); `label` just tags the check names. */
function checkNetwork(label: string, entries: TrafficEntry[]): void {
  const http = entries.filter((e) => e.url.startsWith("http://") || e.url.startsWith("https://"));
  const offOrigin = http.filter((e) => new URL(e.url).origin !== BASE);
  check(`${label}: no request went to any other host`, offOrigin.length === 0, offOrigin.slice(0, 5).map((e) => e.url).join(", "));

  const playback = http.filter((e) => /\/jf\/e\/[^/]+\/(master\.m3u8|main\.m3u8|seg_\d{5}\.ts)(\?|$)/.test(new URL(e.url).pathname));
  const badStatus = playback.filter((e) => e.status !== 200 && e.status !== 206);
  check(
    `${label}: every playlist/segment response was 200/206`,
    playback.length > 0 && badStatus.length === 0,
    `${playback.length} checked, ${badStatus.length} bad`,
  );
  const wrongPath = playback.filter((e) => !/^\/api\/video\/\d+\/jf\/e\//.test(new URL(e.url).pathname));
  check(`${label}: every playlist/segment request used /api/video/<id>/jf/e/...`, wrongPath.length === 0, wrongPath.slice(0, 3).map((e) => e.url).join(", "));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "mediavault-e2e-engine-"));
  const cacheDir = path.join(dir, "video-cache");
  for (const sub of ["movies", "posters", "video-cache"]) mkdirSync(path.join(dir, sub));
  const dbUrl = `file:${path.join(dir, "e2e.db")}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const { token, filmAId, filmAVersionId, filmBId } = await seed(prisma, path.join(dir, "movies"));

  const timings: Record<string, number> = {};

  const { child, logPath } = startNextDev(dir, dbUrl, cacheDir);
  let browser: Browser | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.E2E_CHROMIUM || undefined,
      args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"],
    });

    // ==== Film A: copy-tier, two audio tracks, quality + audio switching ====
    const ctxA = await newContext(browser, token);
    const page = await ctxA.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR (film A):", e.message));
    const trafficA = recordTraffic(page);

    // ---- 1. Play button with no Jellyfin configured; starts within 10s;
    // duration is finite and ~120s (a real VOD playlist, not a live one).
    await page.goto(`/film/${filmAId}`);
    const playButtons = page.getByRole("button", { name: "Play" });
    check("Film A's page shows Play with no Jellyfin configured", (await playButtons.count()) > 0);

    const t0 = Date.now();
    await playButtons.first().click();
    await page.locator("video").waitFor({ timeout: 20_000 });
    const first = await waitForPlayable(page, 0.5, 10_000);
    const timeToFirstFrameMs = Date.now() - t0;
    timings["Film A time-to-first-frame"] = timeToFirstFrameMs;
    check(
      "Film A starts playing within 10s of clicking Play (currentTime advancing, readyState >= 3)",
      first !== null,
      first ? `${timeToFirstFrameMs}ms, ct=${first.t.toFixed(1)}s, rs=${first.readyState}` : `timed out after ${timeToFirstFrameMs}ms`,
    );
    check(
      "Film A's duration is finite and ~120s (VOD playlist, not live)",
      first !== null && Number.isFinite(first.duration) && Math.abs(first.duration - FILM_A_DURATION) < 3,
      first ? `duration=${first.duration}` : "no video",
    );

    // ---- 2. Cold far seek to ~90s: resumes within 10s, keeps advancing,
    // seekable.end(0) ~= duration.
    {
      const start = Date.now();
      await seekTo(page, 90);
      const resumed = await waitForPlayable(page, 89, 10_000);
      const elapsed = Date.now() - start;
      timings["Film A cold far seek (copy tier) to ~90s"] = elapsed;
      check("Film A: cold far seek to ~90s resumes within 10s", resumed !== null, resumed ? `${elapsed}ms, ct=${resumed.t.toFixed(1)}s` : `timed out after ${elapsed}ms`);
      if (resumed) {
        const advanced = await waitForTimeAbove(page, resumed.t + 0.3, 8_000);
        check("Film A: currentTime keeps advancing after the far seek", advanced > resumed.t, `${resumed.t.toFixed(1)}s -> ${advanced.toFixed(1)}s`);
        check(
          "Film A: seekable.end(0) ~= duration after the far seek",
          Math.abs(resumed.seekableEnd - resumed.duration) < 3,
          `seekable.end=${resumed.seekableEnd.toFixed(1)}, duration=${resumed.duration.toFixed(1)}`,
        );
      }
    }

    // ---- 3. Seek back to ~30s -- a region the initial head at 0 and the
    // head restarted at 90 didn't necessarily both reach -- plays within 10s.
    {
      const start = Date.now();
      await seekTo(page, 30);
      const resumed = await waitForPlayable(page, 29, 10_000);
      const elapsed = Date.now() - start;
      timings["Film A seek back to ~30s"] = elapsed;
      check("Film A: seek back to ~30s plays within 10s", resumed !== null, resumed ? `${elapsed}ms, ct=${resumed.t.toFixed(1)}s` : `timed out after ${elapsed}ms`);
      if (resumed) await waitForTimeAbove(page, resumed.t + 0.3, 8_000);
    }

    // Give the position a little room above WATCH_PROGRESS_MIN_SECS (30s)
    // before the quality/audio switches carry it forward, so check 8's
    // resume-position assertion isn't right on the threshold.
    await sleep(2_000);

    // ---- 5. Quality switch to Remote mid-play keeps position (+/-3s); the
    // new playlistUrl's key contains "-remote-".
    {
      const before = await sampleVideo(page);
      const respPromise = page.waitForResponse(
        (res) => res.request().method() === "POST" && new URL(res.url()).pathname.endsWith("/jf/session") && new URL(res.url()).searchParams.get("variant") === "remote",
        { timeout: 15_000 },
      );
      await page.getByLabel("Playback quality").selectOption("remote");
      const res: Response = await respPromise;
      const body = await res.json().catch(() => null);
      const key = body?.playlistUrl ? keyFromPlaylistUrl(body.playlistUrl) : null;
      check("Film A: quality switch requests a new session for Remote", res.ok(), `status ${res.status()}`);
      check("Film A: Remote session's key contains -remote-", Boolean(key && key.includes("-remote-")), key ?? "no key");

      const resumed = await waitForPlayable(page, (before?.t ?? 0) - 4, 10_000);
      check(
        "Film A: quality switch keeps position within +/-3s",
        resumed !== null && before !== null && Math.abs(resumed.t - before.t) <= 3,
        resumed && before ? `${before.t.toFixed(1)}s -> ${resumed.t.toFixed(1)}s` : "no sample",
      );
    }

    // ---- 6. Audio switch to the second track keeps position (+/-3s); the
    // new key ends with that track's stream index (a2).
    {
      const before = await sampleVideo(page);
      const respPromise = page.waitForResponse(
        (res) => res.request().method() === "POST" && new URL(res.url()).pathname.endsWith("/jf/session") && new URL(res.url()).searchParams.get("audio") === "2",
        { timeout: 15_000 },
      );
      await page.getByLabel("Audio track").selectOption("2");
      const res: Response = await respPromise;
      const body = await res.json().catch(() => null);
      const key = body?.playlistUrl ? keyFromPlaylistUrl(body.playlistUrl) : null;
      check("Film A: audio switch requests a new session for stream 2", res.ok(), `status ${res.status()}`);
      check("Film A: new key ends with the chosen audio stream index (-a2)", Boolean(key && key.endsWith("-a2")), key ?? "no key");

      const resumed = await waitForPlayable(page, (before?.t ?? 0) - 4, 10_000);
      check(
        "Film A: audio switch keeps position within +/-3s",
        resumed !== null && before !== null && Math.abs(resumed.t - before.t) <= 3,
        resumed && before ? `${before.t.toFixed(1)}s -> ${resumed.t.toFixed(1)}s` : "no sample",
      );
    }

    // ---- 4. Network audit for everything Film A's page has done so far.
    checkNetwork("Film A", trafficA);

    // ---- 7. Close sends POST .../jf/stop; within 5s no ffmpeg children of
    // the dev server remain.
    {
      const beforeClose = trafficA.length;
      await page.getByRole("button", { name: "Close" }).click();
      await sleep(500);
      const stopReq = trafficA.slice(beforeClose).find((e) => e.method === "POST" && /\/jf\/stop(\?|$)/.test(new URL(e.url).pathname));
      check("Film A: closing the player sends POST .../jf/stop", Boolean(stopReq), stopReq ? `status ${stopReq.status}` : "not seen");

      const deadline = Date.now() + 5_000;
      let remaining = child.pid ? ffmpegDescendantsOf(child.pid) : [];
      while (remaining.length > 0 && Date.now() < deadline) {
        await sleep(250);
        remaining = child.pid ? ffmpegDescendantsOf(child.pid) : [];
      }
      check("Film A: no ffmpeg child processes remain within 5s of stop", remaining.length === 0, remaining.join(","));
    }

    // ---- 8. Reopen Film A: resumes near the saved position.
    {
      const progressRes = await ctxA.request.get(`/api/video/${filmAVersionId}/progress`);
      const progress = await progressRes.json();
      check("Film A: progress was saved after closing", typeof progress.positionSecs === "number" && progress.positionSecs >= 30, `positionSecs=${progress.positionSecs}`);

      await page.getByRole("button", { name: "Play" }).first().click();
      await page.locator("video").waitFor({ timeout: 20_000 });
      const resumed = await waitForPlayable(page, Math.max(0, progress.positionSecs - 6), 15_000);
      check(
        "Film A: reopening resumes near the saved position",
        resumed !== null && Math.abs(resumed.t - progress.positionSecs) <= 6,
        resumed ? `resumed at ${resumed.t.toFixed(1)}s, saved ${progress.positionSecs.toFixed(1)}s` : "did not resume",
      );

      await page.getByRole("button", { name: "Close" }).click();
      await sleep(1_000);
    }

    await ctxA.close();

    // ==== Film B: transcode tier ====
    const ctxB = await newContext(browser, token);
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (e) => console.log("PAGE ERROR (film B):", e.message));
    const trafficB = recordTraffic(pageB);

    await pageB.goto(`/film/${filmBId}`);
    const playB = pageB.getByRole("button", { name: "Play" });
    check("Film B's page shows Play with no Jellyfin configured", (await playB.count()) > 0);

    // ---- 9. Film B (transcode tier) plays within 15s; cold seek to ~60s
    // plays within 15s.
    {
      const start = Date.now();
      await playB.first().click();
      await pageB.locator("video").waitFor({ timeout: 20_000 });
      const played = await waitForPlayable(pageB, 0.5, 15_000);
      const elapsed = Date.now() - start;
      timings["Film B time-to-first-frame (transcode tier)"] = elapsed;
      check("Film B (transcode tier) plays within 15s", played !== null, played ? `${elapsed}ms, ct=${played.t.toFixed(1)}s` : `timed out after ${elapsed}ms`);
    }
    {
      const start = Date.now();
      await seekTo(pageB, 60);
      const resumed = await waitForPlayable(pageB, 59, 15_000);
      const elapsed = Date.now() - start;
      timings["Film B cold seek (transcode tier) to ~60s"] = elapsed;
      check("Film B: cold seek to ~60s plays within 15s", resumed !== null, resumed ? `${elapsed}ms, ct=${resumed.t.toFixed(1)}s` : `timed out after ${elapsed}ms`);
    }

    checkNetwork("Film B", trafficB);

    await pageB.getByRole("button", { name: "Close" }).click();
    await sleep(2_000);
    await ctxB.close();

    // ---- 10. Cache directory hygiene: only stream-key directories, holding
    // only segment files / plan.json / .atime / .complete -- no .part-* left.
    {
      let topLevel: string[] = [];
      try {
        topLevel = readdirSync(cacheDir);
      } catch {
        topLevel = [];
      }
      check("VIDEO_CACHE_DIR has at least one stream directory", topLevel.length > 0, topLevel.join(","));
      for (const name of topLevel) {
        const full = path.join(cacheDir, name);
        const isDir = statSync(full).isDirectory();
        check(`cache entry "${name}" is a directory matching the stream-key pattern`, isDir && STREAM_KEY_RE.test(name));
        if (!isDir) continue;
        const inner = readdirSync(full);
        const unexpected = inner.filter((f) => !(f === "plan.json" || f === ".atime" || f === ".complete" || SEGMENT_FILE_RE.test(f)));
        check(`"${name}" holds only seg_*.ts/plan.json/.atime/.complete`, unexpected.length === 0, unexpected.join(","));
        const partDirs = inner.filter((f) => f.startsWith(".part-"));
        check(`"${name}" has no leftover .part-* staging directories`, partDirs.length === 0, partDirs.join(","));
      }
    }
  } catch (err) {
    failures++;
    console.error("\nRun aborted:", err instanceof Error ? err.message : err);
    console.error(`\n--- tail of ${logPath} ---`);
    console.error(readFileSync(logPath, "utf8").split("\n").slice(-60).join("\n"));
  } finally {
    await browser?.close();
    stopNextDev(child);
    await prisma.$disconnect();
  }

  console.log("\nTimings:");
  for (const [label, ms] of Object.entries(timings)) console.log(`  ${label}: ${ms}ms`);

  if (failures === 0) {
    rmSync(dir, { recursive: true, force: true });
    console.log("\nALL PASSED");
    process.exit(0);
  }
  console.log(`\n${failures} FAILED — scratch dir kept for inspection: ${dir}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
