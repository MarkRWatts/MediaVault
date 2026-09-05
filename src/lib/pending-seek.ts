// Where a <video> should go once its source is ready: the saved resume
// position, or the position the viewer was at when they switched quality.
//
// The catch is an in-progress HLS prepare. ffmpeg writes an *event* playlist
// (no ENDLIST until it finishes), and Apple's native player treats that as
// live: it reports duration = Infinity, starts near the newest segment, and
// silently clamps a seek to anywhere it hasn't fetched yet. Checking a
// target against `duration` is therefore meaningless there -- what matters
// is the end of the element's `seekable` range, which is exactly how much
// ffmpeg has written so far. This helper makes that decision from plain
// numbers so it can be unit-tested without a media element.

export interface SeekableRange {
  start: number;
  end: number;
}

export type PendingSeekDecision =
  /** Enough is written: set currentTime to `position` now. */
  | { action: "seek"; position: number }
  /** The target lies past what's been written; `readyUpTo` is how far
   *  playback could go right now. Hold and ask again as more lands. */
  | { action: "wait"; readyUpTo: number }
  /** The element hasn't reported any seekable media yet. Ask again later. */
  | { action: "not-ready" }
  /** The target is at or past the final end -- there's nothing to resume
   *  to. Play from the start instead. */
  | { action: "drop" };

/** Seconds of media the element could seek into right now, or null if it
 *  hasn't told us anything yet. Prefers the seekable range (accurate for a
 *  growing playlist); falls back to a finite duration (direct play before
 *  the range is populated). */
export function writtenEnd(seekable: SeekableRange[], duration: number): number | null {
  if (seekable.length > 0) return seekable[seekable.length - 1].end;
  if (Number.isFinite(duration) && duration > 0) return duration;
  return null;
}

/**
 * `durationIsFinal` says whether a finite `duration` can be trusted as the
 * end of the film: true for direct play and a fully prepared playlist, false
 * while preparing (hls.js reports the written length as a finite, growing
 * duration; the native player reports Infinity). Only a final duration can
 * justify dropping the target -- otherwise a target past the end just means
 * "not written yet", and the answer is to wait.
 */
export function decidePendingSeek(
  target: number,
  seekable: SeekableRange[],
  duration: number,
  durationIsFinal: boolean,
): PendingSeekDecision {
  if (durationIsFinal && Number.isFinite(duration) && duration > 0 && target >= duration) return { action: "drop" };
  const end = writtenEnd(seekable, duration);
  if (end === null) return { action: "not-ready" };
  if (target <= end) return { action: "seek", position: target };
  return { action: "wait", readyUpTo: end };
}

/** Copy a TimeRanges into plain ranges (TimeRanges has no iterator). */
export function timeRangesToArray(ranges: { length: number; start(i: number): number; end(i: number): number }): SeekableRange[] {
  const out: SeekableRange[] = [];
  for (let i = 0; i < ranges.length; i++) out.push({ start: ranges.start(i), end: ranges.end(i) });
  return out;
}

/** m:ss or h:mm:ss for the "ready up to" hint. */
export function formatClock(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
