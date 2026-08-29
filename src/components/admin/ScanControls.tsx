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
  running: boolean;
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
  running: false,
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
  jellyfinSync: "/api/jellyfin-sync",
};

const OP_RUN_KEY: Record<OpKey, Exclude<keyof RunsResponse, "running">> = {
  scanFilm: "latestScanFilm",
  scanTv: "latestScanTv",
  scanMusic: "latestScanMusic",
  scanScene: "latestScanScene",
  enrichFilm: "latestEnrichFilm",
  enrichTv: "latestEnrichTv",
  enrichMusic: "latestEnrichMusic",
  enrichScene: "latestEnrichScene",
  jellyfinSync: "latestJellyfin",
};

const SECTIONS: { title: string; scan: OpKey; enrich: OpKey }[] = [
  { title: "Film", scan: "scanFilm", enrich: "enrichFilm" },
  { title: "TV Shows", scan: "scanTv", enrich: "enrichTv" },
  { title: "Music", scan: "scanMusic", enrich: "enrichMusic" },
  { title: "Adult", scan: "scanScene", enrich: "enrichScene" },
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

function StatusLine({ run, activeLabel }: { run: RunInfo | null; activeLabel: string }) {
  if (!run) return <span className="text-text-faint">Never run</span>;
  if (run.status === "RUNNING") {
    return (
      <span className="text-text-muted">
        {activeLabel}
        {run.total > 0 ? ` ${run.progress}/${run.total}…` : "…"}
      </span>
    );
  }
  return (
    <span className="text-text-faint">
      {run.status === "FAILED" ? <span className="text-missing">Failed</span> : "Done"} ·{" "}
      {relativeTime(run.finishedAt ?? run.startedAt)}
      {run.status === "FAILED" && run.message ? ` — ${run.message}` : ""}
    </span>
  );
}

export default function ScanControls() {
  const [runs, setRuns] = useState<RunsResponse>(EMPTY);
  const [reachable, setReachable] = useState(true);
  const [pending, setPending] = useState<OpKey | null>(null);
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
    async (op: OpKey) => {
      setPending(op);
      try {
        await fetch(OP_ENDPOINT[op], { method: "POST" });
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
                    onClick={() => trigger(section.scan)}
                    disabled={scanRunning || pending === section.scan}
                    className="inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Run
                  </button>
                </div>
                <div className="text-xs" aria-live="polite">
                  <StatusLine run={scanRun} activeLabel="Scanning" />
                </div>
              </div>

              <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-text">Fetch metadata</span>
                  <button
                    type="button"
                    onClick={() => trigger(section.enrich)}
                    disabled={enrichRunning || pending === section.enrich}
                    className="inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Run
                  </button>
                </div>
                <div className="text-xs" aria-live="polite">
                  <StatusLine run={enrichRun} activeLabel="Fetching metadata" />
                </div>
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
              Matches films/episodes/scenes to Jellyfin library items by path — runs automatically
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
      </div>
    </div>
  );
}
