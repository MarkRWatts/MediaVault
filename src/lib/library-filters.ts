// Pure predicates behind the Movies page's dropdown filters
// (src/components/LibraryBrowser.tsx). Kept out of the component so they can
// be tested without rendering, and so the format rule stays honestly next to
// the section rule it has to agree with.

import type { Format, ResolutionTier } from "@/lib/constants";

/** The three media a film can be filtered to. Deliberately not the whole of
 *  FORMATS: HD/SD/UNKNOWN name a rip's resolution rather than a disc anyone
 *  owns, and the browse grid already files them under "Other". */
export const FORMAT_FILTERS = ["UHD", "BLURAY", "DVD"] as const;
export type FormatFilterKey = (typeof FORMAT_FILTERS)[number];

export const FORMAT_FILTER_LABEL: Record<FormatFilterKey, string> = {
  UHD: "UltraHD",
  BLURAY: "Blu-ray",
  DVD: "DVD",
};

/** The film-shaped fields the format predicate reads — a structural subset
 *  of LibraryFilm so a test can hand it three fields rather than a film. */
export interface FormatFilterable {
  formats: Format[];
  physicalMedia: Format[];
  bestTier: ResolutionTier;
}

/**
 * Does this film count as `format`?
 *
 * Unlike formatSectionFor (LibraryBrowser.tsx), which has to pick exactly
 * one shelf per film and so treats physicalMedia only as a fallback, a
 * filter is a membership question: owning the Blu-ray AND having ripped the
 * DVD matches both, and neither answer is "better". Ripped formats and owned
 * discs are therefore unioned rather than preferred.
 *
 * What is shared with formatSectionFor is the vocabulary: only the three
 * disc media match by name (an HD or SD rip is not a Blu-ray or a DVD), and
 * a 4K-resolution rip counts as UltraHD however its Version.format was
 * classified — otherwise filtering to UltraHD would empty out films the
 * "UltraHD Blu-ray (4K)" section is showing.
 */
export function matchesFormat(film: FormatFilterable, format: FormatFilterKey): boolean {
  const held = film.formats.includes(format) || film.physicalMedia.includes(format);
  return format === "UHD" ? held || film.bestTier.rank === 0 : held;
}
