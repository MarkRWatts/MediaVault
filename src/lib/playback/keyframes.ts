// Keyframe lookup for the copy-tier segment table (V4_PLAN.md "The engine"
// → "Segment table" / "Keyframe index"): the Matroska Cues reader first,
// ffprobe (whole file — never called from the scanner, see scanner.ts) as
// the fallback for everything else, or an MKV/WebM whose Cues turned out to
// be missing/empty.

import path from "node:path";
import { runFfprobeRaw } from "@/lib/ffprobe";
import { readMatroskaCues } from "./matroska-cues";

const MATROSKA_EXTENSIONS = new Set([".mkv", ".webm"]);

function isMatroskaContainer(absPath: string): boolean {
  return MATROSKA_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}

export interface CuesKeyframes {
  keyframeSecs: number[];
  bytesRead: number;
}

/**
 * Cues-only lookup — cheap (a few hundred KB, see matroska-cues.ts), so this
 * is what the scanner hook calls directly. Never throws: a non-Matroska
 * file, a missing/empty Cues element, or a parse error on a malformed file
 * all just mean "no index yet", which the caller (scanner: skip; getKeyframes
 * below: fall back to ffprobe) is expected to handle.
 */
export async function getCuesKeyframes(absPath: string): Promise<CuesKeyframes | null> {
  if (!isMatroskaContainer(absPath)) return null;
  try {
    const result = await readMatroskaCues(absPath);
    if (!result.keyframeSecs || result.keyframeSecs.length === 0) return null;
    return { keyframeSecs: result.keyframeSecs, bytesRead: result.bytesRead };
  } catch {
    return null;
  }
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

export type KeyframeSource = "cues" | "ffprobe";

export interface KeyframesResult {
  keyframeSecs: number[];
  source: KeyframeSource;
}

/**
 * Resolve keyframe timestamps for a file, trying the cheap Cues reader
 * before ever falling back to a whole-file ffprobe pass. This is the
 * on-demand path the engine (phase 2) uses when a copy-tier play has no
 * cached KeyframeIndex row yet — never call this from the scanner, which
 * must only use getCuesKeyframes() (see scanner.ts's comment on the hook).
 */
export async function getKeyframes(absPath: string): Promise<KeyframesResult | null> {
  const cues = await getCuesKeyframes(absPath);
  if (cues) return { keyframeSecs: cues.keyframeSecs, source: "cues" };

  const ffprobeKeyframes = await getKeyframesFromFfprobe(absPath);
  if (!ffprobeKeyframes) return null;
  return { keyframeSecs: ffprobeKeyframes, source: "ffprobe" };
}

export interface SegmentTableEntry {
  index: number;
  start: number;
  duration: number;
}

/**
 * Copy-tier segment table (V4_PLAN.md): boundaries can only fall on source
 * keyframes, so a new segment starts at the first keyframe at or after
 * `targetSecs` past the previous cut — the same rule ffmpeg's own HLS muxer
 * applies, so the EXTINF values this produces match what ffmpeg will
 * actually write. The last segment always runs to `durationSecs`, and
 * segment 0 always starts at 0 regardless of whether 0 is itself a
 * keyframe (nearly always is, for a real encode).
 */
export function segmentTableFromKeyframes(keyframes: number[], durationSecs: number, targetSecs = 6): SegmentTableEntry[] {
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

/**
 * Transcoded-video segment table: fixed `targetSecs` boundaries, the last
 * segment taking whatever remainder is left of `durationSecs`.
 */
export function fixedSegmentTable(durationSecs: number, targetSecs = 6): SegmentTableEntry[] {
  if (!(durationSecs > 0)) return [];

  const segments: SegmentTableEntry[] = [];
  let start = 0;
  let index = 0;
  while (start < durationSecs) {
    const end = Math.min(start + targetSecs, durationSecs);
    segments.push({ index, start, duration: end - start });
    start = end;
    index++;
  }
  return segments;
}
