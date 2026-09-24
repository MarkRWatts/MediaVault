// Shared pure types for the v4 playback engine (V4_PLAN.md, "The engine").
// No I/O, no ffmpeg, no Prisma -- plain data shapes the rest of the engine
// (segment tables, playlists, head argument building) agrees on.

import type { Variant } from "../video-playback";

/**
 * One VOD HLS segment's position in a rendition's timeline, in seconds.
 * `start` is the segment's absolute start time in the *source* (with
 * -copyts on the ffmpeg side, source time and container time are the same
 * number -- see head-args.ts); `duration` is how long it runs.
 *
 * Computed once per stream key and *dictated to* ffmpeg rather than
 * predicted from it (V4_PLAN.md, "Segment table") -- this table is never
 * recomputed from what a head actually produced.
 */
export interface SegmentEntry {
  index: number;
  start: number;
  duration: number;
}

/**
 * `PLAYBACK_HWACCEL` (V4_PLAN.md, "Hardware switch"). "none" is the
 * software libx264 path CI and Macs run (no iGPU there); "vaapi" is the
 * production choice on the HD Graphics 530 VM (measured fastest and best
 * quality, 19 Sep 2026); "qsv" stays selectable.
 */
export type HwAccel = "none" | "vaapi" | "qsv";

/**
 * The kinds of playable file the engine names stream keys for: a film
 * Version, a Scene (video-cache.ts's existing `MediaKind` split), and an
 * Episode file, which lives in its own id space
 * (`/api/tv-video/:episodeFileId`).
 */
export type MediaKind = "film" | "scene" | "episode";

/**
 * The parts of a stream key (V4_PLAN.md, "Stream key"):
 * `<kind>-<id>-<variant>-a<audioStreamIdx|default>`. See stream-key.ts for
 * the string encoding, validation and the `adefault` token used for a file
 * with no audio stream at all (`audioStreamIndex: null`, matching
 * `VideoPlaybackPlan.audioStreamIndex` in video-playback.ts).
 */
export interface StreamKeyParts {
  kind: MediaKind;
  id: number;
  variant: Variant;
  audioStreamIndex: number | null;
}

/**
 * What the session-time ffprobe (V4_PLAN.md, "Session-time probe") supplies
 * that the database doesn't hold: enough to decide keyframe alignment,
 * deinterlacing and the 10-bit software-decode fallback. `width`/`height`
 * are the source's own, pre-scale, dimensions.
 */
export interface SourceFacts {
  fps: number | null;
  pixFmt: string | null;
  interlaced: boolean;
  width: number;
  height: number;
  /** Video `color_transfer` ("smpte2084" is HDR10's PQ, "arib-std-b67" is
   *  HLG), for the master playlist's VIDEO-RANGE. Optional so a fixture
   *  that predates it still types. */
  colorTransfer?: string | null;
}
