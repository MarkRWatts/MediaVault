"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface RunInfo {
  id: number;
  kind: string;
  status: "RUNNING" | "DONE" | "FAILED" | string;
  startedAt: string;
  finishedAt: string | null;
  progress: number;
  total: number;
  message: string | null;
  log: string[];
}

interface RunsResponse {
  latestScanFilm: RunInfo | null;
  latestScanTv: RunInfo | null;
  latestScanMusic: RunInfo | null;
  latestScanScene: RunInfo | null;
  latestEnrichFilm: RunInfo | null;
  latestEnrichTv: RunInfo | null;
  latestEnrichMusic: RunInfo | null;
  latestEnrichScene: RunInfo | null;
  latestJellyfin: RunInfo | null;
  latestScanConcert: RunInfo | null;
  latestEnrichConcert: RunInfo | null;
  running: boolean;
  // When the periodic sync next fires, or null when it's off — see
  // src/lib/scheduler.ts.
  nextSyncAt: string | null;
}

const EMPTY: RunsResponse = {
  latestScanFilm: null,
  latestScanTv: null,
  latestScanMusic: null,
  latestScanScene: null,
  latestEnrichFilm: null,
  latestEnrichTv: null,
  latestEnrichMusic: null,
  latestEnrichScene: null,
  latestJellyfin: null,
  latestScanConcert: null,
  latestEnrichConcert: null,
  running: false,
  nextSyncAt: null,
};

type OpKey =
  | "scanFilm"
  | "scanTv"
  | "scanMusic"
  | "scanScene"
  | "enrichFilm"
  | "enrichTv"
  | "enrichMusic"
  | "enrichScene"
  | "scanConcert"
  | "enrichConcert"
  | "jellyfinSync";

const OP_ENDPOINT: Record<OpKey, string> = {
  scanFilm: "/api/scan/film",
  scanTv: "/api/scan/tv",
  scanMusic: "/api/scan/music",
  scanScene: "/api/scan/scene",
  enrichFilm: "/api/enrich/film",
  enrichTv: "/api/enrich/tv",
  enrichMusic: "/api/enrich-music",
  enrichScene: "/api/enrich/scene",
  scanConcert: "/api/scan/concert",
  enrichConcert: "/api/enrich/concert",
  jellyfinSync: "/api/jellyfin-sync",
};

const OP_RUN_KEY: Record<OpKey, Exclude<keyof RunsResponse, "running" | "nextSyncAt">> = {
  scanFilm: "latestScanFilm",
  scanTv: "latestScanTv",
  scanMusic: "latestScanMusic",
  scanScene: "latestScanScene",
  enrichFilm: "latestEnrichFilm",
  enrichTv: "latestEnrichTv",
  enrichMusic: "latestEnrichMusic",
  enrichScene: "latestEnrichScene",
  scanConcert: "latestScanConcert",
  enrichConcert: "latestEnrichConcert",
  jellyfinSync: "latestJellyfin",
};

const SECTIONS: { title: string; scan: OpKey; enrich: OpKey }[] = [
  { title: "Film", scan: "scanFilm", enrich: "enrichFilm" },
  { title: "TV Shows", scan: "scanTv", enrich: "enrichTv" },
  { title: "Music", scan: "scanMusic", enrich: "enrichMusic" },
  { title: "Adult", scan: "scanScene", enrich: "enrichScene" },
  { title: "Concerts", scan: "scanConcert", enrich: "enrichConcert" },
];

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

function elapsed(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function nextSyncLabel(iso: string | null): string {
  if (!iso) return "Automatic sync is off.";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Automatic sync is off.";
  const mins = Math.max(0, Math.round((then - Date.now()) / 60_000));
  const when = mins < 1 ? "any moment" : mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  const clock = new Date(then).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Next automatic sync: ${when} (${clock}).`;
}

function StatusLine({ run, activeLabel }: { run: RunInfo | null; activeLabel: string }) {
  if (!run) return <span className="text-text-faint">Never run</span>;
  if (run.status === "RUNNING") {
    return (
      <span className="text-text-muted">
        {activeLabel}
        {run.total > 0 ? ` ${run.progress}/${run.total}…` : "…"}
        {run.message ? ` — ${run.message}` : ""}
      </span>
    );
  }
  const took = elapsed(run.startedAt, run.finishedAt);
  return (
    <span className="text-text-faint">
      {run.status === "FAILED" ? <span className="text-missing">Failed</span> : "Done"} ·{" "}
      {relativeTime(run.finishedAt ?? run.startedAt)}
      {took ? ` · took ${took}` : ""}
      {run.message ? ` — ${run.message}` : ""}
    </span>
  );
}

// The scan/enrichment jobs write their log in one go when the run ends, so
// the lines land as a block on whichever poll follows; the status line above
// is what moves while a run is still going.
function RunLog({ run }: { run: RunInfo | null }) {
  const boxRef = useRef<HTMLPreElement>(null);
  const lines = run?.log ?? [];

  // Newest line at the bottom, so keep the view pinned there as a poll
  // lengthens the log.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);

  if (lines.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-text-faint transition-colors hover:text-text-muted">
        Log ({lines.length} line{lines.length === 1 ? "" : "s"})
      </summary>
      <pre
        ref={boxRef}
        className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-bg p-2 font-mono text-[11px] leading-relaxed text-text-muted"
      >
        {lines.join("\n")}
      </pre>
    </details>
  );
}

export default function ScanControls() {
  const [runs, setRuns] = useState<RunsResponse>(EMPTY);
  const [reachable, setReachable] = useState(true);
  const [pending, setPending] = useState<OpKey | null>(null);
  const [force, setForce] = useState(false);
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

  // Fetches inline here, rather than delegating to fetchRuns, so the
  // setState calls are visibly scoped to this effect's own cleanup.
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
    async (op: OpKey, body?: Record<string, unknown>) => {
      setPending(op);
      try {
        await fetch(OP_ENDPOINT[op], {
          method: "POST",
          ...(body
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        });
      } catch {
        // ignored — next poll reflects reality either way
      } finally {
        setPending(null);
        fetchRuns();
      }
    },
    [fetchRuns],
  );

  const tmdbHint =
    (runs.latestEnrichFilm?.status === "FAILED" && runs.latestEnrichFilm.message?.includes("TMDB_API_KEY")) ||
    (runs.latestEnrichTv?.status === "FAILED" && runs.latestEnrichTv.message?.includes("TMDB_API_KEY"));
  const theporndbHint =
    runs.latestEnrichScene?.status === "FAILED" && runs.latestEnrichScene.message?.includes("THEPORNDB_API_KEY");

  return (
    <div className="flex flex-col gap-4">
      {!reachable && (
        <p className="text-sm text-missing">Couldn&apos;t reach the scan/metadata status endpoint.</p>
      )}
      {tmdbHint && (
        <p className="text-sm text-accent/80">Add TMDB_API_KEY to your environment to enable film/TV metadata fetching.</p>
      )}
      {theporndbHint && (
        <p className="text-sm text-accent/80">Add THEPORNDB_API_KEY to your environment to enable Adult metadata fetching.</p>
      )}

      <p className="text-xs text-text-faint">{nextSyncLabel(runs.nextSyncAt)}</p>

      <label className="flex items-center gap-1.5 self-start text-xs text-text-faint">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border accent-accent"
        />
        Force: re-probe every file on rescan, and refresh metadata for already-matched titles on fetch (slow)
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {SECTIONS.map((section) => {
          const scanRun = runs[OP_RUN_KEY[section.scan]];
          const enrichRun = runs[OP_RUN_KEY[section.enrich]];
          const scanRunning = scanRun?.status === "RUNNING";
          const enrichRunning = enrichRun?.status === "RUNNING";

          return (
            <div key={section.title} className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
              <h3 className="font-display text-sm tracking-wide text-text">{section.title}</h3>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-text">Rescan library</span>
                  <button
                    type="button"
                    onClick={() => trigger(section.scan, { force })}
                    disabled={scanRunning || pending === section.scan}
                    className="inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Run
                  </button>
                </div>
                <div className="text-xs" aria-live="polite">
                  <StatusLine run={scanRun} activeLabel="Scanning" />
                </div>
                <RunLog run={scanRun} />
              </div>

              <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-text">Fetch metadata</span>
                  <button
                    type="button"
                    onClick={() => trigger(section.enrich, { force })}
                    disabled={enrichRunning || pending === section.enrich}
                    className="inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Run
                  </button>
                </div>
                <div className="text-xs" aria-live="polite">
                  <StatusLine run={enrichRun} activeLabel="Fetching metadata" />
                </div>
                <RunLog run={enrichRun} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm tracking-wide text-text">Jellyfin</h3>
            <p className="mt-0.5 text-xs text-text-faint">
              Matches films/episodes/scenes/concerts to Jellyfin library items by path — runs automatically
              after each scan, or trigger it directly (e.g. after renaming files on the share, or
              adding new Adult scenes) without a full rescan.
            </p>
          </div>
          <button
            type="button"
            onClick={() => trigger("jellyfinSync")}
            disabled={runs.latestJellyfin?.status === "RUNNING" || pending === "jellyfinSync"}
            className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Relink Jellyfin
          </button>
        </div>
        <div className="text-xs" aria-live="polite">
          <StatusLine run={runs.latestJellyfin} activeLabel="Syncing" />
        </div>
        <RunLog run={runs.latestJellyfin} />
      </div>
    </div>
  );
}
