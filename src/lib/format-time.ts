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
