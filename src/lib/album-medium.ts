// Guess an album's physical medium (VINYL vs CD) from a free-text format
// string — MusicBrainz's media[0].format (e.g. "12\" Vinyl") or Discogs'
// formats join (e.g. "Vinyl LP Album"). Shared between the scan page's
// client-side medium picker and scan-resolve.ts's server-side "is this
// specific medium already owned" check, so both agree on the same guess.

export function guessAlbumMedium(format: string | null): "CD" | "VINYL" {
  return format?.toLowerCase().includes("vinyl") ? "VINYL" : "CD";
}
