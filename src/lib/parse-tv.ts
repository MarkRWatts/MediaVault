// TV filename/path parser for the Jellyfin-ish layout actually on the share:
//   Show (Year)/Season 01/Show S01E01.mkv     (padded season folders)
//   Show (Year)/Season 1/…                    (unpadded)
//   Show (Year)/Show S01E01 (2002).mkv        (flat — no season folders)
//   Show (Year)/Show S02E09.mkv               (single loose episode)
// Episode numbering follows the files (DVD order for DVD rips — e.g. Firefly,
// where TMDB numbers the season the same way and only air dates are jumbled),
// so consumers must order by episode number, never by air date.

import { parseFileName } from "./parse";

export interface ParsedEpisodeFile {
  relPath: string;
  fileName: string;
  /** Top-level show folder name, e.g. "Firefly (2002)". */
  showFolder: string;
  showTitle: string;
  showYear: number | null;
  season: number;
  /** All episode numbers this file covers (usually one; ranges supported). */
  episodes: number[];
  container: string;
}

const EPISODE_RE = /\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:\s*[-–]?\s*E(\d{1,3}))?/i;
const SEASON_FOLDER_RE = /^season[ ._-]*(\d{1,2})$/i;

/** Parse "Show (Year)" from the top-level folder name. */
export function parseShowFolder(folder: string): { title: string; year: number | null } {
  const m = folder.match(/^(.*?)\s*\(((?:19|20)\d{2})\)\s*$/);
  if (m) return { title: m[1].trim(), year: Number(m[2]) };
  return { title: folder.trim(), year: null };
}

/**
 * Parse one episode file path (relative to the TV root). Returns null when the
 * file carries no SxxEyy code (extras, samples) — callers log those.
 */
export function parseEpisodePath(relPath: string): ParsedEpisodeFile | null {
  const parts = relPath.split("/");
  if (parts.length < 2) return null; // loose file at TV root — not a show
  const showFolder = parts[0];
  const fileName = parts[parts.length - 1];

  const code = fileName.match(EPISODE_RE);
  if (!code) return null;

  let season = Number(code[1]);
  // A season folder overrides a mismatched code (rare, but folders are the
  // organizational truth); folders like "Season 1"/"Season 01" both match.
  if (parts.length >= 3) {
    const sf = parts[1].match(SEASON_FOLDER_RE);
    if (sf) season = Number(sf[1]);
  }

  const first = Number(code[2]);
  const last = code[3] ? Number(code[3]) : first;
  const episodes: number[] = [];
  for (let e = first; e <= Math.max(first, last); e++) episodes.push(e);

  const { title, year } = parseShowFolder(showFolder);
  const dotIdx = fileName.lastIndexOf(".");

  return {
    relPath,
    fileName,
    showFolder,
    showTitle: title,
    showYear: year,
    season,
    episodes,
    container: dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "",
  };
}

export { parseFileName };
