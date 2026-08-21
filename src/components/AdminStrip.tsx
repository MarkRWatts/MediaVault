"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface RunInfo {
  id: number;
  kind: "SCAN" | "ENRICH" | string;
  status: "RUNNING" | "DONE" | "FAILED" | string;
  startedAt: string;
  finishedAt: string | null;
  progress: number;
  total: number;
  message: string | null;
}

interface RunsResponse {
  latestScan: RunInfo | null;
  latestEnrich: RunInfo | null;
  running: boolean;
}

const KIND_LABEL: Record<string, string> = {
  SCAN: "Scanning",
  ENRICH: "Fetching metadata",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSecs = Math.round((Date.now() - then) / 1000);
  if (diffSecs < 5) return "just now";
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const mins = Math.round(diffSecs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// filmDB has not run a scan/enrich yet, or the /api routes aren't reachable
// (e.g. mid-build while another agent finishes them) — fail quiet, no strip.
const EMPTY: RunsResponse = { latestScan: null, latestEnrich: null, running: false };

export default function AdminStrip() {
  const [runs, setRuns] = useState<RunsResponse>(EMPTY);
  const [reachable, setReachable] = useState(true);
  const [pending, setPending] = useState<"scan" | "enrich" | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, forceTick] = useState(0);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data: RunsResponse = await res.json();
      setRuns(data);
      setReachable(true);
      return data;
    } catch {
      setReachable(false);
      return null;
    }
  }, []);

  // Poll every 3s only while a run is active; otherwise fetch once on mount.
  // (Fetches inline here, rather than delegating to fetchRuns, so the
  // setState calls are visibly scoped to this effect's own cleanup.)
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data: RunsResponse = await res.json();
        if (!ignore) {
          setRuns(data);
          setReachable(true);
        }
      } catch {
        if (!ignore) setReachable(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (runs.running && !intervalRef.current) {
      intervalRef.current = setInterval(fetchRuns, 3000);
    }
    if (!runs.running && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [runs.running, fetchRuns]);

  // Keep "…ago" labels fresh without depending on a poll.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const trigger = useCallback(
    async (kind: "scan" | "enrich") => {
      setPending(kind);
      try {
        await fetch(`/api/${kind}`, { method: "POST" });
      } catch {
        // ignored — next poll reflects reality either way
      } finally {
        setPending(null);
        fetchRuns();
      }
    },
    [fetchRuns],
  );

  if (!reachable && !runs.latestScan && !runs.latestEnrich) return null;

  const running = runs.running;
  const activeRun = [runs.latestScan, runs.latestEnrich].find((r) => r?.status === "RUNNING");
  const mostRecent = [runs.latestScan, runs.latestEnrich]
    .filter((r): r is RunInfo => r !== null)
    .sort((a, b) => new Date(b.finishedAt ?? b.startedAt).getTime() - new Date(a.finishedAt ?? a.startedAt).getTime())[0];

  const tmdbHint =
    runs.latestEnrich?.status === "FAILED" && runs.latestEnrich.message?.includes("TMDB_API_KEY");

  return (
    <div className="flex items-center gap-3 text-xs">
      {tmdbHint && (
        <span className="hidden text-accent/80 sm:inline">
          Add TMDB_API_KEY to enable metadata
        </span>
      )}

      <div className="hidden text-text-faint sm:block" aria-live="polite">
        {activeRun ? (
          <span className="text-text-muted">
            {KIND_LABEL[activeRun.kind] ?? "Working"}
            {activeRun.total > 0 ? ` ${activeRun.progress}/${activeRun.total}…` : "…"}
          </span>
        ) : mostRecent ? (
          <span>
            {mostRecent.kind === "SCAN" ? "Scan" : "Enrich"}{" "}
            {mostRecent.status === "FAILED" ? (
              <span className="text-missing">failed</span>
            ) : (
              "done"
            )}{" "}
            · {relativeTime(mostRecent.finishedAt ?? mostRecent.startedAt)}
          </span>
        ) : (
          <span>No scans yet</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => trigger("scan")}
          disabled={running || pending !== null}
          className="rounded-md border border-border px-2.5 py-1 font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Rescan library
        </button>
        <button
          type="button"
          onClick={() => trigger("enrich")}
          disabled={running || pending !== null}
          className="rounded-md border border-border px-2.5 py-1 font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          Fetch metadata
        </button>
      </div>
    </div>
  );
}
