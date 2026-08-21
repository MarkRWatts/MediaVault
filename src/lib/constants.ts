// String "enums" — SQLite has no native enums (see prisma/schema.prisma).

export const FORMATS = ["BLURAY", "DVD", "HD", "SD", "UNKNOWN"] as const;
export type Format = (typeof FORMATS)[number];

export const MATCH_CONFIDENCE = ["EXACT", "SEARCH", "LOW", "UNMATCHED"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export const RUN_KINDS = ["SCAN", "ENRICH"] as const;
export const RUN_STATUSES = ["RUNNING", "DONE", "FAILED"] as const;

// Source-format judgement from actual video width (heights lie: widescreen
// rips crop letterboxing, so a 1080p BluRay rip may be 1920x800 and a DVD rip
// 720x304 — width is the stable signal).
export function classifyFormat(width?: number | null): Format {
  if (!width || width <= 0) return "UNKNOWN";
  if (width >= 1200) return "BLURAY"; // 1920/1440-wide (and 1280 = 720p BluRay)
  if (width >= 900) return "HD"; // odd web-ish middle ground
  return "DVD"; // 720/704/700-wide PAL/NTSC
}

const FORMAT_LABELS: Record<string, string> = {
  BLURAY: "Blu-ray",
  DVD: "DVD",
  HD: "HD",
  SD: "SD",
  UNKNOWN: "Unknown",
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format;
}
