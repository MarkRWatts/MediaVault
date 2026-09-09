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
