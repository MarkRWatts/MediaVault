// Keyframe lookup for the copy-tier segment table (V4_PLAN.md "The engine"
// → "Segment table" / "Keyframe index"): the container's own index first --
// Matroska Cues (matroska-cues.ts) or MP4's sync-sample table
// (mp4-sync-samples.ts) -- and ffprobe (whole file — never called from the
// scanner, see scanner.ts) as the fallback for everything else: another
// container, or a file whose index turned out to be missing or unreadable.

import path from "node:path";
import { runFfprobeRaw } from "@/lib/ffprobe";
import { readMatroskaCues } from "./matroska-cues";
import { readMp4SyncSamples } from "./mp4-sync-samples";
import type { KeyframeSource } from "./keyframe-store";
import type { SegmentEntry } from "@/lib/playback/types";

const MATROSKA_EXTENSIONS = new Set([".mkv", ".webm"]);
const MP4_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

export interface IndexKeyframes {
  keyframeSecs: number[];
  bytesRead: number;
  source: Extract<KeyframeSource, "cues" | "stss">;
}

/**
 * The container's own keyframe index -- cheap (a few hundred KB to a few MB,
 * never the media data), so this is what the scanner hook calls directly.
 * Never throws: another container, a missing/empty index, or a parse error
 * on a malformed file all just mean "no index yet", which the caller
 * (scanner: skip; getKeyframes below: fall back to ffprobe) is expected to
 * handle.
 */
export async function getIndexKeyframes(absPath: string): Promise<IndexKeyframes | null> {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (MATROSKA_EXTENSIONS.has(ext)) {
      const result = await readMatroskaCues(absPath);
      if (!result.keyframeSecs || result.keyframeSecs.length === 0) return null;
      return { keyframeSecs: result.keyframeSecs, bytesRead: result.bytesRead, source: "cues" };
    }
    if (MP4_EXTENSIONS.has(ext)) {
      const result = await readMp4SyncSamples(absPath);
      if (!result.keyframeSecs || result.keyframeSecs.length === 0) return null;
      return { keyframeSecs: result.keyframeSecs, bytesRead: result.bytesRead, source: "stss" };
    }
  } catch {
    return null;
  }
  return null;
}

// `packet=pts_time,flags`, one CSV row per video packet, e.g. "12.345600,K_"
// — flags containing "K" are keyframes. `-of csv=p=0` drops the leading
// "packet," field name csv would otherwise print per row.
const KEYFRAME_FFPROBE_ARGS = ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"];

async function getKeyframesFromFfprobe(absPath: string): Promise<number[] | null> {
  const stdout = await runFfprobeRaw(KEYFRAME_FFPROBE_ARGS, absPath);
  const secs: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ptsTimeStr, flags] = trimmed.split(",");
    if (!flags || !flags.includes("K")) continue;
    const ptsTime = Number(ptsTimeStr);
    if (Number.isFinite(ptsTime)) secs.push(ptsTime);
  }
  if (secs.length === 0) return null;
  return [...new Set(secs)].sort((a, b) => a - b);
}

export interface KeyframesResult {
  keyframeSecs: number[];
  source: KeyframeSource;
}

/**
 * Resolve keyframe timestamps for a file, trying the container's own index
 * before ever falling back to a whole-file ffprobe pass. This is the
 * on-demand path the engine (phase 2) uses when a copy-tier play has no
 * cached KeyframeIndex row yet — never call this from the scanner, which
 * must only use getIndexKeyframes() (see scanner.ts's comment on the hook).
 */
export async function getKeyframes(absPath: string): Promise<KeyframesResult | null> {
  const indexed = await getIndexKeyframes(absPath);
  if (indexed) return { keyframeSecs: indexed.keyframeSecs, source: indexed.source };

  const ffprobeKeyframes = await getKeyframesFromFfprobe(absPath);
  if (!ffprobeKeyframes) return null;
  return { keyframeSecs: ffprobeKeyframes, source: "ffprobe" };
}

/**
 * Copy-tier segment table (V4_PLAN.md): boundaries can only fall on source
 * keyframes, so a new segment starts at the first keyframe at or after
 * `targetSecs` past the previous cut. The table is dictated to ffmpeg as an
 * explicit cut list (head-args.ts), not predicted from a muxer's own rule
 * -- ffmpeg's HLS muxer cuts on a grid from the start of each run, which a
 * restarted head doesn't share (V4_PLAN.md, "Heads"). The last segment always runs to `durationSecs`, and
 * segment 0 always starts at 0 regardless of whether 0 is itself a
 * keyframe (nearly always is, for a real encode).
 */
export function segmentTableFromKeyframes(keyframes: number[], durationSecs: number, targetSecs = 6): SegmentEntry[] {
  if (!(durationSecs > 0)) return [];

  const sorted = [...new Set(keyframes)].filter((k) => k >= 0 && k < durationSecs).sort((a, b) => a - b);

  const cuts: number[] = [0];
  let prevCut = 0;
  for (const k of sorted) {
    if (k <= prevCut) continue; // at/behind the current cut — can't start a new segment here
    if (k - prevCut >= targetSecs) {
      cuts.push(k);
      prevCut = k;
    }
  }

  return cuts.map((start, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1] : durationSecs;
    return { index: i, start, duration: end - start };
  });
}

const MIN_FINAL_SEGMENT_SECS = 1;

/**
 * Transcoded-video segment table: fixed `targetSecs` boundaries, the last
 * segment taking whatever remainder is left of `durationSecs`.
 */
export function fixedSegmentTable(durationSecs: number, targetSecs = 6): SegmentEntry[] {
  if (!(durationSecs > 0)) return [];

  const segments: SegmentEntry[] = [];
  let start = 0;
  let index = 0;
  while (start < durationSecs) {
    const end = Math.min(start + targetSecs, durationSecs);
    segments.push({ index, start, duration: end - start });
    start = end;
    index++;
  }
  // A remainder under a second (a 60.006 s source) would be a 6 ms final
  // segment -- legal, but a pointless extra request and a file some players
  // handle badly. Fold it into the one before.
  if (segments.length > 1 && segments[segments.length - 1].duration < MIN_FINAL_SEGMENT_SECS) {
    const tail = segments.pop()!;
    segments[segments.length - 1].duration += tail.duration;
  }
  return segments;
}
