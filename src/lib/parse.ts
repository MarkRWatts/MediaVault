// Filename → film identity parser for the Jellyfin-ish naming actually found
// on the share. Tolerates: missing years, underscores for spaces, tags glued
// to the year with no space, a stray " - " before tags, "(Special Edition)"
// in parens instead of brackets, and "(2003)mkv.mkv"-style typos.

export interface ParsedFile {
  /** Path relative to the movies root, POSIX separators. */
  relPath: string;
  fileName: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  /** "Extended Edition", "2003 Directors Cut", "Theatrical Release", … */
  edition: string | null;
  /** Resolution claimed by the filename tag, e.g. 1080. Probe data wins. */
  resolutionTag: number | null;
  /** Top-level folder when the file is inside one ("James Bond 007"). */
  folder: string | null;
  container: string;
}

export const VIDEO_EXTENSIONS = new Set([
  "mkv", "mp4", "m4v", "avi", "mov", "wmv", "ts", "m2ts", "webm", "mpg", "mpeg", "iso",
]);

const YEAR_RE = /\((19|20)\d{2}\)/g;
const EDITION_WORDS = /(edition|cut|release|version|remaster|extended|theatrical|unrated|uncut)/i;

export function parseFileName(relPath: string): ParsedFile {
  const parts = relPath.split("/");
  const fileName = parts[parts.length - 1];
  const folder = parts.length > 1 ? parts[0] : null;

  const dotIdx = fileName.lastIndexOf(".");
  const container = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "";
  let stem = dotIdx >= 0 ? fileName.slice(0, dotIdx) : fileName;

  // Underscores are space stand-ins in this corpus (The_A-Team, Road_Wars).
  stem = stem.replace(/_/g, " ");

  let imdbId: string | null = null;
  let tmdbId: number | null = null;
  let edition: string | null = null;
  let resolutionTag: number | null = null;

  // Pull out every [bracket] tag and classify it.
  stem = stem.replace(/\[([^\]]*)\]/g, (_, raw: string) => {
    const tag = raw.trim();
    let m;
    if ((m = tag.match(/^imdbid[-=]?(tt\d+)$/i))) imdbId = m[1].toLowerCase();
    else if ((m = tag.match(/^tmdbid[-=]?(\d+)$/i))) tmdbId = Number(m[1]);
    else if ((m = tag.match(/^(\d{3,4})[pi]$/i))) resolutionTag = Number(m[1]);
    else if (tag) edition = tag;
    return " ";
  });

  // Year: the LAST (19xx|20xx) group — titles like "2001 A Space Odyssey
  // (1968)" put digits first, and "Blade Runner 2049 (2017)" has a bare year
  // in the title, so only parenthesised years count.
  let year: number | null = null;
  const yearMatches = [...stem.matchAll(YEAR_RE)];
  if (yearMatches.length > 0) {
    const last = yearMatches[yearMatches.length - 1];
    year = Number(last[0].slice(1, -1));
    // Title is what precedes the year; tolerate "(2003)mkv" trailing typos by
    // discarding whatever follows the year group.
    stem = stem.slice(0, last.index);
  }

  // "(Special Edition)" style parenthesised editions left in the title part.
  stem = stem.replace(/\(([^)]*)\)/g, (_, raw: string) => {
    const inner = raw.trim();
    if (EDITION_WORDS.test(inner) && !edition) edition = inner;
    return EDITION_WORDS.test(inner) ? " " : `(${inner})`;
  });

  const title = stem
    .replace(/\s*-\s*$/, "") // stray " - " before tags/year
    .replace(/\s+/g, " ")
    .trim();

  return {
    relPath,
    fileName,
    title: title || fileName,
    year,
    imdbId,
    tmdbId,
    edition,
    resolutionTag,
    folder,
    container,
  };
}

/**
 * Key that groups multiple files (editions, DVD + BluRay rips) into one Film.
 * imdbId is authoritative when present; otherwise normalised title + year.
 */
export function filmKey(p: ParsedFile): string {
  if (p.imdbId) return `imdb:${p.imdbId}`;
  if (p.tmdbId) return `tmdb:${p.tmdbId}`;
  return `title:${normalizeTitle(p.title)}:${p.year ?? "?"}`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents: Léon → leon
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sort key: lowercased, leading article stripped ("The Matrix" → "matrix"). */
export function sortTitle(title: string): string {
  return normalizeTitle(title).replace(/^(the|a|an) /, "");
}
