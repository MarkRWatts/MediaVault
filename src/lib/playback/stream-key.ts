// A stream key names one deterministic rendition of one file (V4_PLAN.md,
// "Stream key"): `<kind>-<id>-<variant>-a<audioStreamIdx>`, or `adefault`
// when the file has no audio stream at all (`planVideoPlayback` returns
// `audioStreamIndex: null` -- see video-playback.ts).
//
// The key becomes a cache directory name under `VIDEO_CACHE_DIR` *and* a
// URL path segment (`/api/video/:versionId/play/<key>/...`), so it is
// validated against a tight allowlist regex before it ever touches the
// filesystem or a response -- V4_PLAN.md, "Housekeeping": "ffmpeg only ever
// receives validated integers and enum values plus a path resolved from the
// database; ... segment names are matched against a strict pattern before
// touching the disk." This file is where both patterns live.

import { VARIANTS, type Variant } from "../video-playback";
import type { SegmentContainer } from "./decisions";
import type { MediaKind, StreamKeyParts } from "./types";

const KINDS: readonly MediaKind[] = ["film", "scene", "episode"];

// Anchored start to end: a key is either wholly this shape or rejected
// outright, never partially matched and "cleaned up". Kind and variant are
// closed enums; id and the audio token are digits only -- no dots, slashes
// or anything else a path or URL segment could smuggle through.
export const STREAM_KEY_RE = /^(film|scene|episode)-([1-9][0-9]*)-(original|remote)-a(default|[0-9]+)$/;

export function buildStreamKey(parts: StreamKeyParts): string {
  if (!KINDS.includes(parts.kind)) throw new Error(`invalid stream key kind: ${String(parts.kind)}`);
  if (!Number.isInteger(parts.id) || parts.id <= 0) throw new Error(`invalid stream key id: ${parts.id}`);
  if (!VARIANTS.includes(parts.variant)) throw new Error(`invalid stream key variant: ${String(parts.variant)}`);
  if (
    parts.audioStreamIndex !== null &&
    (!Number.isInteger(parts.audioStreamIndex) || parts.audioStreamIndex < 0)
  ) {
    throw new Error(`invalid stream key audio stream index: ${parts.audioStreamIndex}`);
  }

  const audioToken = parts.audioStreamIndex === null ? "default" : String(parts.audioStreamIndex);
  const key = `${parts.kind}-${parts.id}-${parts.variant}-a${audioToken}`;

  // Belt and braces: whatever we just assembled from validated parts must
  // still pass the same regex a caller uses to validate one read off a URL.
  // If it doesn't, the two are out of sync -- a bug here, not a bad request.
  if (!STREAM_KEY_RE.test(key)) throw new Error(`built an invalid stream key: ${key}`);
  return key;
}

export function parseStreamKey(raw: string): StreamKeyParts | null {
  const m = STREAM_KEY_RE.exec(raw);
  if (!m) return null;
  const [, kind, idStr, variant, audioToken] = m;
  const id = Number(idStr);
  if (!Number.isSafeInteger(id)) return null;
  return {
    kind: kind as MediaKind,
    id,
    variant: variant as Variant,
    audioStreamIndex: audioToken === "default" ? null : Number(audioToken),
  };
}

// One completed segment file's name, e.g. "seg_00042.ts". Five digits caps
// a key at 100,000 segments -- at HLS_SEGMENT_SECS (6s) that's ~166 hours,
// comfortably beyond any real file.
export const SEGMENT_FILE_RE = /^seg_\d{5}\.ts$/;

export function segmentFileName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99999) {
    throw new Error(`segment index out of range: ${index}`);
  }
  return `seg_${String(index).padStart(5, "0")}.ts`;
}

export function parseSegmentFileName(name: string): number | null {
  if (!SEGMENT_FILE_RE.test(name)) return null;
  return Number(name.slice(4, 9));
}

// A segment's name in a playlist and a URL. On disk every segment is
// `seg_NNNNN.ts` whatever it holds -- the directory's plan.json says which
// (decisions.ts's segmentContainerFor) -- but a player is told the truth:
// an fMP4 media segment is `.m4s`.
export const SEGMENT_URL_RE = /^seg_\d{5}\.(ts|m4s)$/;

export function segmentUrlName(index: number, container: SegmentContainer): string {
  const name = segmentFileName(index);
  return container === "fmp4" ? name.replace(/\.ts$/, ".m4s") : name;
}

export function parseSegmentUrlName(name: string): number | null {
  if (!SEGMENT_URL_RE.test(name)) return null;
  return Number(name.slice(4, 9));
}
