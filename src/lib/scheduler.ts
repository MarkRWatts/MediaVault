// The app's only scheduled work: one chained timer that pulls the same
// levers /admin does — scan every library, fetch each one's metadata, then
// relink Jellyfin — so files that appeared on the share overnight are in
// the database by morning without anyone opening the admin page.
//
// Started from src/instrumentation.ts, which Next calls once per server
// boot. Every step goes through the same guardAndCreateRun mutex the HTTP
// routes use, so a manual run already in progress is never doubled up on:
// that step is skipped for this tick rather than queued behind it.

import { prisma } from "@/lib/db";
import { runScan, SCAN_MEDIA_TYPES, SCAN_PATH_ENV, type ScanMediaType } from "@/lib/scanner";
import { runEnrich } from "@/lib/tmdb";
import { runMusicEnrich } from "@/lib/discogs";
import { runEnrichScene } from "@/lib/theporndb";
import { runJellyfinSync } from "@/lib/jellyfin";
import { ensureGaplessCopies } from "@/lib/gapless-copies";

const MS_PER_HOUR = 3_600_000;
const DEFAULT_INTERVAL_HOURS = 4;
// setTimeout's delay is a signed 32-bit millisecond count; anything larger
// wraps and fires immediately, which would turn a fat-fingered interval
// into a scan loop.
const MAX_INTERVAL_MS = 2 ** 31 - 1;
const RUN_POLL_MS = 2_000;
// How long a step is waited on before the tick gives up on it. 30 minutes
// matches runs.ts's stale-run window: past that the next run of that kind
// supersedes this one anyway, so there is nothing left to wait for.
const RUN_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

interface StartedRun {
  runId: number;
  started: boolean;
}

// Which "Fetch metadata" button each library's row on /admin maps to. A
// media type with no entry here has no metadata source, so it is scanned
// and then left alone. Never forced: the nightly pass is for rows that
// have yet to match, not for re-reading the whole library from TMDB.
const ENRICH_STARTER: Partial<Record<ScanMediaType, () => Promise<StartedRun>>> = {
  FILM: () => runEnrich("FILM"),
  TV: () => runEnrich("TV"),
  MUSIC: () => runMusicEnrich(),
  SCENE: () => runEnrichScene(),
  CONCERT: () => runEnrich("CONCERT"),
};

export interface SyncDeps {
  mediaTypes: readonly ScanMediaType[];
  libraryConfigured: (mediaType: ScanMediaType) => boolean;
  startScan: (mediaType: ScanMediaType) => Promise<StartedRun>;
  startEnrich: (mediaType: ScanMediaType) => Promise<StartedRun | null>;
  startJellyfinSync: () => Promise<StartedRun>;
  waitForRun: (runId: number) => Promise<void>;
}

/**
 * How often the periodic sync should run, in milliseconds, or null when it
 * is switched off. `SYNC_INTERVAL_HOURS` takes fractions (0.01 for a
 * ~36-second loop while testing) and 0 to disable. Unset means the default
 * in production and off everywhere else, so `next dev` never decides to
 * walk the whole share on its own; setting it explicitly turns it on there
 * too.
 */
export function parseSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.SYNC_INTERVAL_HOURS?.trim();
  if (!raw) {
    return env.NODE_ENV === "production" ? DEFAULT_INTERVAL_HOURS * MS_PER_HOUR : null;
  }

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.warn(`[scheduler] SYNC_INTERVAL_HOURS="${raw}" isn't a number of hours — periodic sync stays off`);
    return null;
  }
  if (hours === 0) return null;
  return Math.min(hours * MS_PER_HOUR, MAX_INTERVAL_MS);
}

async function step(label: string, start: () => Promise<StartedRun | null>, deps: SyncDeps): Promise<void> {
  try {
    const result = await start();
    if (!result) return;
    if (!result.started) {
      console.log(`[scheduler] ${label} skipped — that kind is already running`);
      return;
    }
    await deps.waitForRun(result.runId);
    console.log(`[scheduler] ${label} done`);
  } catch (err) {
    // One library's failure costs that library, not the rest of the tick
    // and certainly not the loop.
    console.error(`[scheduler] ${label} failed:`, err);
  }
}

/** One pass: every library scanned, then every library's metadata, then
 *  Jellyfin. In that order because enrichment can only match rows the scan
 *  has already created. */
export async function runSyncTick(deps: SyncDeps): Promise<void> {
  const startedAt = Date.now();
  console.log("[scheduler] periodic sync starting");

  const libraries = deps.mediaTypes.filter((mediaType) => deps.libraryConfigured(mediaType));
  for (const mediaType of libraries) {
    await step(`${mediaType} scan`, () => deps.startScan(mediaType), deps);
  }
  for (const mediaType of libraries) {
    await step(`${mediaType} metadata`, () => deps.startEnrich(mediaType), deps);
  }
  await step("Jellyfin relink", () => deps.startJellyfinSync(), deps);

  console.log(`[scheduler] periodic sync finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

// The run* helpers return as soon as the ScanRun row exists — the work
// itself carries on in the background — so that row is the only thing that
// can say when a step is actually done.
async function waitForRun(runId: number): Promise<void> {
  const deadline = Date.now() + RUN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
    const run = await prisma.scanRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (!run || run.status !== "RUNNING") return;
  }
  console.warn(`[scheduler] run ${runId} is still going after ${RUN_WAIT_TIMEOUT_MS / 60_000}m — moving on`);
}

const liveDeps: SyncDeps = {
  mediaTypes: SCAN_MEDIA_TYPES,
  libraryConfigured: (mediaType) => Boolean(process.env[SCAN_PATH_ENV[mediaType]]),
  startScan: (mediaType) => runScan(mediaType),
  startEnrich: async (mediaType) => (await ENRICH_STARTER[mediaType]?.()) ?? null,
  startJellyfinSync: () => runJellyfinSync(),
  waitForRun,
};

interface SchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  nextSyncAtMs: number | null;
}

// Parked on globalThis for the reason db.ts parks its client there: dev
// hot-reload re-evaluates this module, and a second copy would mean a
// second timer. It also keeps /api/runs reading the state
// instrumentation.ts wrote, whichever module instance each ends up with.
const globalForScheduler = globalThis as typeof globalThis & { mediavaultScheduler?: SchedulerState };

const state: SchedulerState = (globalForScheduler.mediavaultScheduler ??= { timer: null, nextSyncAtMs: null });

/**
 * Start the periodic sync, unless it is switched off or already started.
 * The first tick is a whole interval away rather than at boot: a deploy
 * restarts the container, and a redeploy is the worst moment to start
 * walking the library.
 */
export function startScheduler(): void {
  if (state.timer) return;

  const intervalMs = parseSyncIntervalMs();
  if (intervalMs === null) {
    console.log("[scheduler] periodic sync is off (SYNC_INTERVAL_HOURS)");
    return;
  }

  console.log(`[scheduler] periodic sync every ${(intervalMs / MS_PER_HOUR).toFixed(2)}h`);
  scheduleNext(intervalMs);
}

function scheduleNext(intervalMs: number): void {
  state.nextSyncAtMs = Date.now() + intervalMs;
  state.timer = setTimeout(() => {
    void tick(intervalMs);
  }, intervalMs);
}

async function tick(intervalMs: number): Promise<void> {
  try {
    await runSyncTick(liveDeps);
    await ensureGaplessCopies();
  } catch (err) {
    console.error("[scheduler] periodic sync failed:", err);
  } finally {
    // Chained, never an interval: a tick that overran its slot must not
    // find the next one already underway.
    scheduleNext(intervalMs);
  }
}

/** When the next automatic sync is due, or null when it is switched off. */
export function getNextSyncAt(): Date | null {
  return state.nextSyncAtMs === null ? null : new Date(state.nextSyncAtMs);
}
