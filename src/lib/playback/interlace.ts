// Whether a transcoded rendition needs deinterlacing, measured rather than
// read off the container header (V4_PLAN.md, "Session-time probe"). The
// header's field_order tells the truth for a genuinely interlaced source
// (a concert video: ffmpeg's `idet` filter measures ~83% TFF against a
// header that says "tt"), but PAL film DVDs routinely store *progressive*
// pictures in a stream flagged "tt" throughout -- verified on this library
// (Finding Nemo, Four Weddings, Jonah Hex, The Italian Job all measure 100%
// progressive despite the header). Neither the container flag nor the
// per-frame interlaced_frame bit MPEG-2 carries can tell the two apart; only
// looking at the actual picture content can, so a header-interlaced file is
// sampled with `idet` before source.ts believes it.
//
// The measurement is cached forever against the file's identity
// (interlace-store.ts, mirroring keyframe-store.ts) and shared across
// concurrent callers by an in-flight promise map, so the cost -- a few
// seconds of ffmpeg across three windows -- is paid at most once per file,
// ever, not once per play.

import { spawn } from "node:child_process";
import { ffmpegPath } from "@/lib/ffmpeg-bin";
import { lowerPriority } from "./priority";
import { loadInterlaceCheck, saveInterlaceCheck, type InterlaceCheckData } from "./interlace-store";
import type { MediaKind } from "./types";

// ---------------------------------------------------------------------------
// idet output
// ---------------------------------------------------------------------------

export interface IdetCounts {
  tff: number;
  bff: number;
  progressive: number;
  undetermined: number;
}

// idet prints this summary once per invocation of the filter -- but a run
// against a real *file* (rather than a raw lavfi source) instantiates the
// filter twice: once during ffmpeg's initial stream probe (which reads zero
// frames and always reports all-zero counts), and once for the actual
// decode. Both print a "Multi frame detection" line, so only the LAST one in
// the output is the real answer. Matched loosely on whitespace: verified
// against a real capture (ffmpeg 9.0.2, Homebrew, 19 Sep 2026) that the
// counts are right-aligned in fixed-width fields ("TFF:     0 BFF:     0").
const MULTI_FRAME_RE = /Multi frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/g;

/** Parse `idet`'s stderr for its last "Multi frame detection" summary line.
 *  null when the filter never printed one (a build without idet, a decode
 *  that failed before any frame was processed). */
export function parseIdetOutput(stderr: string): IdetCounts | null {
  let last: RegExpExecArray | null = null;
  for (const match of stderr.matchAll(MULTI_FRAME_RE)) last = match;
  if (!last) return null;
  return {
    tff: Number(last[1]),
    bff: Number(last[2]),
    progressive: Number(last[3]),
    undetermined: Number(last[4]),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Frames sampled per window. 300 frames is 10-12s of a real film -- enough
 *  for idet's multi-frame comparison to settle past its first few frames
 *  (which it can't classify) without taxing a share read for content this
 *  is only ever a yes/no gate for. */
const FRAMES_PER_WINDOW = 300;

/** How long a single window is given. idet decodes every sampled frame, so
 *  this is bounded by decode speed, not realtime; 20s is generous for 300
 *  frames of anything this library has, and a window that can't finish in
 *  that time is treated as unmeasurable rather than blocking a play. */
const WINDOW_TIMEOUT_MS = 20_000;

/** Below this, three windows can't usefully spread across the runtime --
 *  a single window from the start samples as much of a short file as the
 *  three-window scheme would anyway, without the seeks landing on top of
 *  each other or past EOF. */
const SHORT_DURATION_SECS = 60;

/** Sample points as a fraction of the runtime. Mixed-content discs (a
 *  progressive main feature with an interlaced menu, or vice versa) are why
 *  this samples three separate points rather than one: a single window near
 *  the start could land on a title card or logo bumper that isn't
 *  representative of the feature. */
const WINDOW_FRACTIONS = [0.2, 0.5, 0.8] as const;

/** One window's `idet` args: seek, decode a fixed frame count through the
 *  filter, discard the output. `-an -sn` -- only the video stream's picture
 *  content is in question. */
function idetArgs(absPath: string, startSecs: number): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-ss",
    startSecs.toFixed(3),
    "-i",
    absPath,
    "-map",
    "0:v:0",
    "-frames:v",
    String(FRAMES_PER_WINDOW),
    "-vf",
    "idet",
    "-an",
    "-sn",
    "-f",
    "null",
    "-",
  ];
}

/** Run one idet window, with the same lowered priority a head runs at (this
 *  is a background probe, not a request the viewer is blocked on once their
 *  first segment is out). Rejects on a spawn error, a non-zero exit with no
 *  parseable summary, or the timeout; the caller (measureInterlace) treats
 *  any of those as "this window measured nothing" and moves on. */
function runIdetWindow(absPath: string, startSecs: number): Promise<IdetCounts> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), idetArgs(absPath, startSecs), { stdio: ["ignore", "ignore", "pipe"] });
    lowerPriority(child.pid);

    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`idet window at ${startSecs.toFixed(1)}s timed out after ${WINDOW_TIMEOUT_MS / 1000}s`));
      });
    }, WINDOW_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        const counts = parseIdetOutput(stderr);
        if (!counts) {
          reject(new Error(`idet produced no summary at ${startSecs.toFixed(1)}s (exit ${code})`));
          return;
        }
        resolve(counts);
      });
    });
  });
}

/**
 * Sample a file's actual picture content at three points across its runtime
 * (a single point from 0 for anything under a minute), summing idet's
 * verdict across every window that succeeded. Windows run sequentially, not
 * in parallel -- the production VM this measures on has 2 vCPUs, so racing
 * windows would only make each one slower, never finish the batch sooner.
 *
 * Returns null when every window failed (a share outage, a file ffmpeg
 * can't open at all); a single failed window among others that succeeded
 * still contributes what those measured.
 */
export async function measureInterlace(absPath: string, durationSecs: number): Promise<InterlaceCheckData | null> {
  const starts = durationSecs < SHORT_DURATION_SECS ? [0] : WINDOW_FRACTIONS.map((f) => durationSecs * f);

  let sampledFrames = 0;
  let interlacedFrames = 0;
  let measuredAny = false;

  for (const start of starts) {
    const counts = await runIdetWindow(absPath, start).catch(() => null);
    if (!counts) continue;
    measuredAny = true;
    sampledFrames += counts.tff + counts.bff + counts.progressive;
    interlacedFrames += counts.tff + counts.bff;
  }

  return measuredAny ? { sampledFrames, interlacedFrames } : null;
}

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

/**
 * The fraction of sampled frames idet has to call interlaced before this
 * counts as a real interlaced source. Not zero, for two reasons that both
 * push the same direction: a disc can be mixed content (a progressive
 * feature with an interlaced menu or bumper sampled into one of the three
 * windows), and idet itself throws a few percent of false positives against
 * noisy progressive film grain even with nothing interlaced anywhere. 20% is
 * comfortably above that noise floor and comfortably below what a source
 * that is *actually* interlaced measures (the concert video fixture this was
 * checked against: 1252 of 1500 sampled frames, 83%).
 */
export const INTERLACED_THRESHOLD = 0.2;

/** Below this many sampled frames, a ratio isn't evidence of anything -- a
 *  handful of frames from a truncated read or a near-empty window. The
 *  caller (resolveInterlaced) treats this the same as an unmeasurable file
 *  and falls back to the header rather than trusting the fraction. */
export const MIN_SAMPLED_FRAMES = 100;

/** Pure verdict from a measurement: interlaced when enough was sampled and
 *  the interlaced fraction clears the threshold. */
export function isMeasuredInterlaced(result: InterlaceCheckData): boolean {
  if (result.sampledFrames < MIN_SAMPLED_FRAMES) return false;
  return result.interlacedFrames / result.sampledFrames >= INTERLACED_THRESHOLD;
}

// ---------------------------------------------------------------------------
// resolveInterlaced
// ---------------------------------------------------------------------------

export interface ResolveInterlacedInput {
  kind: MediaKind;
  fileId: number;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
  durationSecs: number;
  /** The container header's own answer (SourceFacts.interlaced before this
   *  measurement, i.e. sourceFactsFromProbe's field_order check). */
  headerInterlaced: boolean;
}

// Concurrent callers for the same file -- two requests racing to start a
// session, or a session-start racing a stream-open for the key it just
// created -- must measure once, not twice. Keyed by identity the same way
// the DB cache is; cleared as soon as the measurement (successful or not)
// settles, since after that a repeat call is a cheap cache read anyway.
const inFlight = new Map<string, Promise<boolean>>();

function inFlightKey(kind: MediaKind, fileId: number): string {
  return `${kind}:${fileId}`;
}

/** The shape of measureInterlace, factored out so tests can inject a fake
 *  one instead of spawning real ffmpeg for every branch of resolveInterlaced
 *  below -- the measurement itself is exercised for real by the gated
 *  integration test. */
type MeasureFn = (absPath: string, durationSecs: number) => Promise<InterlaceCheckData | null>;

async function measureAndDecide(input: ResolveInterlacedInput, measure: MeasureFn): Promise<boolean> {
  const cacheKey = { mtimeMs: input.mtimeMs, sizeBytes: BigInt(input.sizeBytes) };

  const cached = await loadInterlaceCheck(input.kind, input.fileId, cacheKey).catch(() => null);
  if (cached) return isMeasuredInterlaced(cached);

  let measured: InterlaceCheckData | null;
  try {
    measured = await measure(input.absPath, input.durationSecs);
  } catch (err) {
    console.warn(
      `[playback] interlace check ${input.kind} ${input.fileId}: measurement failed (${(err as Error).message}) -- trusting the header`,
    );
    return true;
  }

  if (!measured || measured.sampledFrames < MIN_SAMPLED_FRAMES) {
    console.warn(
      `[playback] interlace check ${input.kind} ${input.fileId}: could not sample enough frames -- trusting the header`,
    );
    return true;
  }

  // Worth caching however it comes out: a "progressive" verdict is exactly
  // as expensive to have measured as an "interlaced" one, and exactly as
  // reusable on the next play.
  await saveInterlaceCheck(input.kind, input.fileId, cacheKey, measured).catch((err: unknown) => {
    console.warn(`[playback] interlace check ${input.kind} ${input.fileId}: failed to cache the measurement: ${err}`);
  });

  const result = isMeasuredInterlaced(measured);
  console.log(
    `[playback] interlace check ${input.kind} ${input.fileId}: ${measured.interlacedFrames}/${measured.sampledFrames} interlaced -> ` +
      `${result ? "interlaced" : "progressive"} (header said interlaced)`,
  );
  return result;
}

export interface ResolveInterlacedDeps {
  /** Tests only: replaces the real ffmpeg-spawning measureInterlace. */
  measure?: MeasureFn;
}

/**
 * The engine's actual answer to "does this rendition need deinterlacing?".
 *
 * A progressive header is trusted outright, with no measurement at all: this
 * library has no case of a progressive-flagged stream carrying interlaced
 * content, and probing every first play on the (unfounded) chance of one
 * would tax every file to guard against none of them. A header-interlaced
 * file is measured -- from cache when fresh, from a real `idet` pass
 * otherwise -- and any way that measurement can fail (a share outage, a
 * timeout, too few frames sampled) falls back to the header's own answer
 * (true), because an unnecessary deinterlace merely softens a picture while
 * a missed one leaves real combing on screen.
 */
export function resolveInterlaced(input: ResolveInterlacedInput, deps: ResolveInterlacedDeps = {}): Promise<boolean> {
  if (!input.headerInterlaced) return Promise.resolve(false);

  const measure = deps.measure ?? measureInterlace;
  const key = inFlightKey(input.kind, input.fileId);
  let job = inFlight.get(key);
  if (!job) {
    job = measureAndDecide(input, measure).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}
