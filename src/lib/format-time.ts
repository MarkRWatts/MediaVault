/** m:ss for a duration in seconds — the player's elapsed/total readouts and
 *  the tracklists' per-track column. Non-finite or negative input reads as
 *  0:00 rather than throwing (a track with no probed duration is common). */
export function formatTime(secs: number | null | undefined): string {
  const clamped = typeof secs === "number" && Number.isFinite(secs) && secs > 0 ? secs : 0;
  const total = Math.floor(clamped);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** "Downloading 40%" when the total is known (the audio route's estimate
 *  from the track's duration — see PlayerLoadProgress in player-types.ts),
 *  else "Downloading 4.2 MB" as a running byte count. Null input (nothing
 *  loading) reads as null, not a placeholder string, so callers can decide
 *  whether to render anything at all. */
export function formatLoadProgress(progress: { loaded: number; total: number | null } | null): string | null {
  if (!progress) return null;
  if (progress.total && progress.total > 0) {
    const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
    return `Downloading ${pct}%`;
  }
  const mb = progress.loaded / (1024 * 1024);
  return `Downloading ${mb < 0.1 ? "…" : `${mb.toFixed(1)} MB`}`;
}

/** Same, but for summing a list: "1:23:45" once it passes an hour. */
export function formatLongTime(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  if (h === 0) return formatTime(total);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Sep 2026" from an ISO timestamp, using the UTC date parts. Fixed
 *  format on purpose: toLocaleDateString() differs between the server's
 *  ICU and the browser's (and between time zones), which React flags as a
 *  hydration mismatch when a Client Component renders it. */
export function formatDateDMY(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "3 days ago" / "just now" from a timestamp, spelled out for a quiet
 *  secondary line (contrast with ScanControls.tsx's own terser `3d ago`,
 *  sized for a cramped admin status row). Always computed against the
 *  current instant, so callers that render this from a Server Component
 *  should expect it to go stale between navigations — fine for the
 *  "last signed in" use it was built for. */
export function formatRelativeTime(date: Date): string {
  const diffSecs = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSecs < 5) return "just now";
  if (diffSecs < 60) return `${diffSecs} second${diffSecs === 1 ? "" : "s"} ago`;
  const mins = Math.round(diffSecs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
