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

// Report threshold (see SPEC-MUSIC.md): an artist only appears in the
// missing-back-catalogue report once we own enough of it to be worth
// completing — keeps 2-of-43 completist catalogues (Zappa) out of the report.
export const MUSIC_REPORT_MIN_OWNED = 2;
export const MUSIC_REPORT_MIN_PCT = 0.2;
