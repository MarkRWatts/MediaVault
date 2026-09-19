// Everything the v4 engine needs to know about one playable file before it
// can name a stream key or spawn a head: where it is on disk, what its
// streams actually are, and what the planner decided to do with them.
//
// One rule runs through this module: the *probe* is ground truth, the
// database is only how a file is found. Version carries AudioTrack rows,
// EpisodeFile carries a single `audioSummary` string and Scene carries
// nothing at all (ADULT_PLAN.md) -- so building the audio menu from the
// database would give three different qualities of answer for the same
// question. V4_PLAN.md's "Session-time probe" settles it: ffprobe the
// container header at session time for every kind, and let the rows be a
// catalogue rather than a playback source of truth. The probe also supplies
// the facts the argument builder needs and no row holds anywhere --
// pix_fmt, frame rate, field order (SourceFacts in types.ts).

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe, type ProbeResult, type ProbedAudioTrack } from "@/lib/ffprobe";
import { audioTrackLabel } from "@/lib/audio-track-label";
import { mediaRootEnv, resolveSourcePath } from "@/lib/video-cache";
import {
  pickAudioTrack,
  planVideoPlayback,
  type StreamAction,
  type Variant,
  type VideoPlaybackPlan,
} from "@/lib/video-playback";
import { tierFor } from "./decisions";
import { resolveInterlaced } from "./interlace";
import type { MediaKind, SourceFacts } from "./types";

/** One audio stream as the player's Audio dropdown shows it -- the same
 *  `{ streamIdx, label }` shape the Jellyfin session returns today
 *  (jellyfin-playback.ts), so the HTTP contract doesn't change. */
export interface PlaybackAudioTrack {
  streamIdx: number;
  label: string;
}

export interface ResolvedSource {
  kind: MediaKind;
  id: number;
  absPath: string;
  /** Cache-key fields for plan.json and the KeyframeIndex row. */
  mtimeMs: number;
  sizeBytes: number;
  durationSecs: number;
  plan: VideoPlaybackPlan;
  facts: SourceFacts;
  audioTracks: PlaybackAudioTrack[];
  /** The stream this rendition will carry: the planner's pick, or the
   *  caller's validated override. null when the file has no audio at all. */
  audioStreamIndex: number | null;
  audioAction: StreamAction | "none";
  /** Channel count of the chosen stream, for sizing an AAC transcode. */
  audioChannels: number | null;
  /** The codec the chosen stream will *come out* as -- the source's when
   *  copied, "aac" when transcoded. plan.outputAudioCodec answers this for
   *  the planner's own pick only, so it is recomputed here for the case
   *  where the caller overrode it. Feeds the master playlist's CODECS. */
  audioCodec: string | null;
}

/** Typed failures the routes turn into a status code, rather than strings
 *  a caller has to pattern-match. */
export type PlaybackErrorCode =
  | "not-found"
  | "not-playable"
  | "invalid-audio-stream"
  | "no-keyframes"
  | "session-cap"
  | "timeout"
  | "aborted"
  | "head-failed"
  | "no-disk-space";

export class PlaybackError extends Error {
  constructor(
    readonly code: PlaybackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlaybackError";
  }
}

// ---------------------------------------------------------------------------
// Probe cache
// ---------------------------------------------------------------------------

/**
 * Smallest useful LRU: a Map already keeps insertion order, so "least
 * recently used" is "first key", and a hit only has to re-insert itself to
 * move to the back.
 */
export class LruCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly max: number) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// A probe of a container header costs one ffprobe spawn (tens of ms locally,
// more over the share). It is asked for on every session start and again
// whenever a stream directory is opened, so a small LRU turns the repeat
// calls into map lookups. Keying by identity rather than by path -- the
// mtime and size that would make the answer stale are part of the key --
// means a changed file simply misses; there is no invalidation to get wrong.
const PROBE_CACHE_MAX = 32;
const probeCache = new LruCache<ProbeResult>(PROBE_CACHE_MAX);

export function probeCacheKey(absPath: string, mtimeMs: number, sizeBytes: number): string {
  return `${absPath}|${mtimeMs}|${sizeBytes}`;
}

async function cachedProbe(absPath: string, mtimeMs: number, sizeBytes: number): Promise<ProbeResult> {
  const key = probeCacheKey(absPath, mtimeMs, sizeBytes);
  const hit = probeCache.get(key);
  if (hit) return hit;
  const result = await probe(absPath);
  probeCache.set(key, result);
  return result;
}

/** Tests only: the cache is module state shared across a test file. */
export function clearProbeCacheForTest(): void {
  probeCache.clear();
}

// ---------------------------------------------------------------------------
// Database lookup
// ---------------------------------------------------------------------------

interface SourceRow {
  filePath: string;
  container: string | null;
  durationSecs: number | null;
}

/** film -> Version under MOVIES_PATH, episode -> EpisodeFile under
 *  TVSHOWS_PATH, scene -> Scene under ADULT_PATH. Only the *locating*
 *  fields are read; the stream details all come from the probe below.
 *  A film whose Film row isn't `owned` is not playable, the same rule
 *  video-cache.ts's loadVersion applies. */
async function loadRow(kind: MediaKind, id: number): Promise<SourceRow | null> {
  if (kind === "film") {
    const version = await prisma.version.findUnique({
      where: { id },
      select: { filePath: true, container: true, durationSecs: true, film: { select: { owned: true } } },
    });
    if (!version || !version.film?.owned) return null;
    return { filePath: version.filePath, container: version.container, durationSecs: version.durationSecs };
  }
  if (kind === "episode") {
    const file = await prisma.episodeFile.findUnique({
      where: { id },
      select: { filePath: true, container: true, durationSecs: true },
    });
    return file ?? null;
  }
  const scene = await prisma.scene.findUnique({
    where: { id },
    select: { filePath: true, container: true, durationSecs: true },
  });
  return scene ?? null;
}

// ---------------------------------------------------------------------------
// Facts and audio
// ---------------------------------------------------------------------------

/** Field orders that mean "the header doesn't claim this is interlaced".
 *  ffprobe reports "progressive" for a progressive stream and omits the
 *  field entirely for a container that doesn't say; "unknown" turns up on
 *  some remuxes. Anything else ("tt", "bb", "tb", "bt") is a header claim of
 *  a real interlaced field order.
 *
 *  This is *only* the header's opinion, not the engine's final answer: a
 *  header-interlaced claim is measured before it's believed (interlace.ts,
 *  resolveInterlaced) because PAL film DVDs routinely flag a stream
 *  interlaced while carrying progressive pictures throughout. A
 *  header-progressive claim, on the other hand, is trusted outright -- see
 *  resolveInterlaced's doc comment for why the asymmetry is deliberate. */
const NON_INTERLACED_FIELD_ORDERS = new Set(["progressive", "unknown"]);

/** The header's own claim, before any measurement. Kept pure and exported
 *  for its own sake (the master/main playlist and the audio menu don't need
 *  a measurement, and this is what resolveSource starts from before
 *  possibly overriding `interlaced` below). */
export function sourceFactsFromProbe(result: ProbeResult): SourceFacts {
  const fieldOrder = result.videoFieldOrder;
  return {
    fps: result.videoFps,
    pixFmt: result.videoPixFmt,
    interlaced: fieldOrder !== null && !NON_INTERLACED_FIELD_ORDERS.has(fieldOrder.toLowerCase()),
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

export function labelAudioTracks(tracks: ProbedAudioTrack[]): PlaybackAudioTrack[] {
  return tracks.map((t) => ({ streamIdx: t.streamIdx, label: audioTrackLabel(t) }));
}

/**
 * Jellyfin-shaped reason tokens for the session response. Nothing in the
 * clients reads them today -- they are a diagnostic the iOS app and the web
 * player pass through -- but keeping the vocabulary means a log or a support
 * question reads the same before and after the cut-over.
 */
export function transcodeReasonsFor(plan: VideoPlaybackPlan, variant: Variant): string[] {
  const reasons: string[] = [];
  if (variant === "remote") reasons.push("VideoBitrateNotSupported");
  else if (plan.videoAction === "transcode") reasons.push("VideoCodecNotSupported");
  if (variant === "remote" || plan.audioAction === "transcode") reasons.push("AudioCodecNotSupported");
  // Every v4 play is HLS-in-MPEG-TS, so the source container is always
  // rewritten -- true even for the MP4s that used to direct-play.
  reasons.push("ContainerNotSupported");
  return reasons;
}

// ---------------------------------------------------------------------------
// resolveSource
// ---------------------------------------------------------------------------

/**
 * Resolve one playable file to everything a stream key needs. `audioStreamIndex`
 * overrides the planner's pick (the player's Audio dropdown) and is validated
 * against the probe: naming a video stream, a subtitle stream or an index the
 * file doesn't have is a bad request, not something to silently fall back
 * from -- a viewer who asked for the commentary and got the main mix has no
 * way to tell.
 *
 * `variant` decides whether `facts.interlaced` is worth measuring rather
 * than just read off the header: copy-tier plays never deinterlace
 * (head-args.ts only ever looks at `source.interlaced` in its transcode
 * branch), so a variant that will copy the video costs nothing extra here,
 * while a variant that will transcode gets the real measurement
 * (interlace.ts's resolveInterlaced, cached per file) instead of trusting a
 * header that PAL film discs routinely get wrong.
 *
 * Returns null when there is no such row, or the share isn't configured.
 * Throws PlaybackError for a file that exists but can't be played.
 */
export async function resolveSource(
  kind: MediaKind,
  id: number,
  variant: Variant,
  audioStreamIndex?: number | null,
): Promise<ResolvedSource | null> {
  const row = await loadRow(kind, id);
  if (!row) return null;

  const absPath = resolveSourcePath(kind, row.filePath);
  if (!absPath) return null;
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new PlaybackError("not-found", `${mediaRootEnv(kind)} has no readable file at ${row.filePath}`);
  }

  const probed = await cachedProbe(absPath, stat.mtimeMs, stat.size);

  // The probe's duration is the one the segment table is cut against, so a
  // row whose stored duration drifted (a re-rip, a bad early scan) can't
  // produce a table that runs off the end of the file.
  const durationSecs = probed.durationSecs ?? row.durationSecs ?? 0;
  if (!(durationSecs > 0)) {
    throw new PlaybackError("not-playable", `${kind} ${id} has no usable duration`);
  }

  const container = row.container ?? path.extname(absPath).replace(/^\./, "");
  const plan = planVideoPlayback({
    videoCodec: probed.videoCodec,
    container,
    audioTracks: probed.audioTracks,
  });
  if (!plan) throw new PlaybackError("not-playable", `${kind} ${id} has no video stream`);

  let chosenIndex = plan.audioStreamIndex;
  let chosenAction = plan.audioAction;
  if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
    const forced = probed.audioTracks.find((t) => t.streamIdx === audioStreamIndex);
    if (!forced) {
      throw new PlaybackError("invalid-audio-stream", `stream ${audioStreamIndex} is not an audio stream of this file`);
    }
    // Ask the planner about this one track so copy-vs-transcode is decided
    // by exactly the same rule as an automatic pick would be.
    const decision = pickAudioTrack([forced]);
    chosenIndex = decision ? decision.index : null;
    chosenAction = decision ? decision.action : "none";
  }

  const chosenTrack = chosenIndex === null ? null : (probed.audioTracks.find((t) => t.streamIdx === chosenIndex) ?? null);

  let facts = sourceFactsFromProbe(probed);
  if (tierFor(variant, plan.videoAction) === "transcode") {
    const interlaced = await resolveInterlaced({
      kind,
      fileId: id,
      absPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      durationSecs,
      headerInterlaced: facts.interlaced,
    });
    facts = { ...facts, interlaced };
  }

  return {
    kind,
    id,
    absPath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    durationSecs,
    plan,
    facts,
    audioTracks: labelAudioTracks(probed.audioTracks),
    audioStreamIndex: chosenIndex,
    audioAction: chosenAction,
    audioChannels: chosenTrack?.channels ?? null,
    audioCodec:
      chosenAction === "none" ? null : chosenAction === "transcode" ? "aac" : ((chosenTrack?.codec ?? "").toLowerCase() || null),
  };
}
