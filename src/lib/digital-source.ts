// Album.digitalSource vocabulary — provenance of an album's digital files.
// Shared by the API route, the album-page form, and the formats report.

export const DIGITAL_SOURCES = ["cd", "itunes", "download", "vinyl-code"] as const;

export type DigitalSource = (typeof DIGITAL_SOURCES)[number];

export const DIGITAL_SOURCE_LABELS: Record<DigitalSource, string> = {
  cd: "CD rip",
  itunes: "iTunes Store",
  download: "Digital download",
  "vinyl-code": "Vinyl download code",
};

export function digitalSourceLabel(source: string | null): string | null {
  if (source === null) return null;
  return (DIGITAL_SOURCE_LABELS as Record<string, string>)[source] ?? source;
}
