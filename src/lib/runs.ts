// Shared ScanRun bookkeeping used by both the scanner and the TMDB enrichment
// job: the single-run-per-kind guard, progress updates, and the summary read
// used by GET /api/runs.

import { prisma } from "@/lib/db";
import type { ScanRun } from "@/generated/prisma/client";

const STALE_RUN_MS = 30 * 60 * 1000; // 30 minutes

export type RunKind =
  | "SCAN_FILM"
  | "SCAN_TV"
  | "SCAN_MUSIC"
  | "SCAN_SCENE"
  | "ENRICH_FILM"
  | "ENRICH_TV"
  | "ENRICH_MUSIC"
  | "ENRICH_SCENE"
  | "JELLYFIN";

/**
 * Guard + register a new run of `kind`. If a RUNNING run of the same kind
 * started less than 30 minutes ago exists, refuses to start a second one and
 * returns it (`started: false`). A RUNNING run older than that is treated as
 * stuck (e.g. the process died mid-scan) — it's marked FAILED and a fresh run
 * is created.
 */
export async function guardAndCreateRun(kind: RunKind): Promise<{ run: ScanRun; started: boolean }> {
  const existing = await prisma.scanRun.findFirst({
    where: { kind, status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });

  if (existing) {
    const ageMs = Date.now() - existing.startedAt.getTime();
    if (ageMs < STALE_RUN_MS) {
      return { run: existing, started: false };
    }
    // Stale/stuck run — supersede it rather than blocking forever.
    await prisma.scanRun.update({
      where: { id: existing.id },
      data: { status: "FAILED", finishedAt: new Date(), message: "Timed out (superseded by a new run)" },
    });
  }

  const run = await prisma.scanRun.create({
    data: { kind, status: "RUNNING", startedAt: new Date() },
  });
  return { run, started: true };
}

export async function updateProgress(
  runId: number,
  data: { progress?: number; total?: number; filesSeen?: number; message?: string },
): Promise<void> {
  await prisma.scanRun.update({ where: { id: runId }, data });
}

export async function finishRun(runId: number, log: string[], message?: string): Promise<void> {
  await prisma.scanRun.update({
    where: { id: runId },
    data: {
      status: "DONE",
      finishedAt: new Date(),
      log: JSON.stringify(log),
      ...(message !== undefined ? { message } : {}),
    },
  });
}

export async function failRun(runId: number, error: unknown, log?: string[]): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.scanRun.update({
    where: { id: runId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      message,
      ...(log ? { log: JSON.stringify(log) } : {}),
    },
  });
}

export interface RunSummary {
  id: number;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  filesSeen: number;
  progress: number;
  total: number;
  message: string | null;
  log: string[];
}

function toSummary(run: ScanRun | null): RunSummary | null {
  if (!run) return null;
  let log: string[] = [];
  if (run.log) {
    try {
      const parsed = JSON.parse(run.log);
      if (Array.isArray(parsed)) log = parsed;
    } catch {
      // ignore malformed log JSON
    }
  }
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    filesSeen: run.filesSeen,
    progress: run.progress,
    total: run.total,
    message: run.message,
    log,
  };
}

const ALL_KINDS: RunKind[] = [
  "SCAN_FILM",
  "SCAN_TV",
  "SCAN_MUSIC",
  "SCAN_SCENE",
  "ENRICH_FILM",
  "ENRICH_TV",
  "ENRICH_MUSIC",
  "ENRICH_SCENE",
  "JELLYFIN",
];

export async function getLatestRuns(): Promise<{
  latestScanFilm: RunSummary | null;
  latestScanTv: RunSummary | null;
  latestScanMusic: RunSummary | null;
  latestScanScene: RunSummary | null;
  latestEnrichFilm: RunSummary | null;
  latestEnrichTv: RunSummary | null;
  latestEnrichMusic: RunSummary | null;
  latestEnrichScene: RunSummary | null;
  latestJellyfin: RunSummary | null;
  running: boolean;
}> {
  const runs = await Promise.all(
    ALL_KINDS.map((kind) => prisma.scanRun.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } })),
  );

  const running = runs.some((r) => r?.status === "RUNNING");

  return {
    latestScanFilm: toSummary(runs[0]),
    latestScanTv: toSummary(runs[1]),
    latestScanMusic: toSummary(runs[2]),
    latestScanScene: toSummary(runs[3]),
    latestEnrichFilm: toSummary(runs[4]),
    latestEnrichTv: toSummary(runs[5]),
    latestEnrichMusic: toSummary(runs[6]),
    latestEnrichScene: toSummary(runs[7]),
    latestJellyfin: toSummary(runs[8]),
    running,
  };
}
