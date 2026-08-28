// Watch-progress thresholds (HOUSEHOLDS_PLAN.md "Watch history & stats",
// Phases 7-8) — shared by the progress API route, the continue-watching
// query, and VideoPlayer.tsx so resume/seek/list-membership logic can't
// drift out of sync between server and client.

// Below this many seconds in, a saved position isn't a real "resume
// point" — it's the same as never having started (someone previewed a
// title for a few seconds and closed it). Applies both to VideoPlayer.tsx
// deciding whether to seek on load and to the continue-watching query
// deciding whether a row counts as "in progress" at all.
export const WATCH_PROGRESS_MIN_SECS = 30;

// Fraction of the runtime at which a play counts as "watched to
// completion". 95% mirrors the resume-prompt convention mainstream
// streaming apps use (Netflix/Plex-style): a viewer who reaches this point
// is treated as done even without sitting through trailing credits, so a
// title doesn't linger in "Continue watching" forever just because nobody
// watches the literal last few percent of a film.
export const WATCH_COMPLETED_RATIO = 0.95;

// How often VideoPlayer.tsx reports playback position while playing, in
// seconds. The <video> element's `timeupdate` event fires several times a
// second — reporting on every tick would be needless request volume for a
// value nobody needs live (a resume position only has to be "close
// enough"). 15s bounds data loss on an ungraceful exit (crash, tab kill) to
// at most that long, while staying well clear of doing real work on every
// frame.
export const WATCH_PROGRESS_REPORT_INTERVAL_SECS = 15;

// String "enums" — SQLite has no native enums (see prisma/schema.prisma).

export const FORMATS = ["UHD", "BLURAY", "DVD", "HD", "SD", "UNKNOWN"] as const;
export type Format = (typeof FORMATS)[number];

export const MATCH_CONFIDENCE = ["EXACT", "SEARCH", "LOW", "UNMATCHED"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export const RUN_KINDS = ["SCAN", "ENRICH", "JELLYFIN"] as const;
export const RUN_STATUSES = ["RUNNING", "DONE", "FAILED"] as const;

// Source-format judgement from actual video width (heights lie: widescreen
// rips crop letterboxing, so a 1080p BluRay rip may be 1920x800 and a DVD rip
// 720x304 — width is the stable signal).
export function classifyFormat(width?: number | null): Format {
  if (!width || width <= 0) return "UNKNOWN";
  if (width >= 3000) return "UHD"; // 3840/4096-wide = 4K UHD Blu-ray
  if (width >= 1200) return "BLURAY"; // 1920/1440-wide (and 1280 = 720p BluRay)
  if (width >= 900) return "HD"; // odd web-ish middle ground
  return "DVD"; // 720/704/700-wide PAL/NTSC
}

const FORMAT_LABELS: Record<string, string> = {
  UHD: "4K UHD",
  BLURAY: "Blu-ray",
  DVD: "DVD",
  HD: "HD",
  SD: "SD",
  UNKNOWN: "Unknown",
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format;
}

// ffprobe codec_name -> friendly label, for the video-codec filter/report
// (mirrors the audio equivalent in @/lib/audio). Anything unrecognised falls
// back to the raw name, uppercased.
const VIDEO_CODEC_LABELS: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  vc1: "VC-1",
  vp9: "VP9",
  av1: "AV1",
};

export function videoCodecLabel(codec: string): string {
  return VIDEO_CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

// Friendly resolution tier for badges: "4K", "1080p", "720p", "576p"…
// Tier from width (stable under letterbox cropping); the SD sub-label uses
// height only when it matches a real PAL/NTSC line count, else plain "SD".
// rank orders tiers best-first for sorting/comparison (0 = best).
export interface ResolutionTier {
  label: string;
  rank: number;
}

export function resolutionTier(width?: number | null, height?: number | null): ResolutionTier {
  if (!width || width <= 0) return { label: "?", rank: 9 };
  if (width >= 3000) return { label: "4K", rank: 0 };
  if (width >= 2200) return { label: "1440p", rank: 1 };
  if (width >= 1700) return { label: "1080p", rank: 2 };
  if (width >= 1100) return { label: "720p", rank: 3 };
  if (height && height >= 570 && height <= 580) return { label: "576p", rank: 4 };
  if (height && height >= 470 && height <= 490) return { label: "480p", rank: 5 };
  return { label: "SD", rank: 6 };
}

// --- Music ---

export const ALBUM_KINDS = [
  "STUDIO",
  "COMPILATION",
  "EP",
  "LIVE",
  "SINGLE",
  "REMIX",
  "SOUNDTRACK",
  "OTHER",
] as const;
export type AlbumKind = (typeof ALBUM_KINDS)[number];

export const MUSIC_EXTENSIONS = new Set(["m4a", "mp3", "m4p", "flac", "aac"]);

// codec -> lossless. `.m4p` (FairPlay DRM) and anything unrecognised are lossy.
const LOSSLESS_CODECS = new Set(["alac", "flac"]);

export function isLosslessCodec(codec?: string | null): boolean {
  if (!codec) return false;
  return LOSSLESS_CODECS.has(codec.toLowerCase());
}

// Gap-tracking threshold (see SPEC-MUSIC.md): missing-album placeholders are
// only created (and the artist only appears in the missing-back-catalogue
// report) once we own enough of the artist to be worth completing — keeps a
// single owned Barenboim disc from spawning 281 missing-album placeholders,
// and keeps 2-of-43 completist catalogues (Zappa) out of the report.
export const MUSIC_GAP_MIN_OWNED = 2;
export const MUSIC_GAP_MIN_PCT = 0.2;
