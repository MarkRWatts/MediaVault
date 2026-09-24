// The show page's small decisions (SHOW_PAGE_PLAN.md), kept out of the page
// so they can be tested on their own: the quiet line's years and season
// count, how an episode is named on the Play button, and which shows count
// as More like this.

/** TMDB's statuses for a show that hasn't finished its run. */
const RUNNING = new Set(["Returning Series", "In Production", "Planned"]);

/** "1997–2007", "2019", or "2022–" while the show is still running: first to
 *  last air year of its seasons proper (a special can air long after the
 *  run), falling back to the specials and then the show's own year. */
export function airYears(
  seasons: { seasonNumber: number; airYear: number | null }[],
  status: string | null,
  showYear: number | null,
): string | null {
  const years = (onlyRegular: boolean) =>
    seasons
      .filter((s) => !onlyRegular || s.seasonNumber !== 0)
      .map((s) => s.airYear)
      .filter((y): y is number => y !== null);
  let found = years(true);
  if (found.length === 0) found = years(false);
  if (found.length === 0 && showYear !== null) found = [showYear];
  if (found.length === 0) return null;
  const first = Math.min(...found);
  const last = Math.max(...found);
  if (status !== null && RUNNING.has(status)) return `${first}–`;
  return first === last ? String(first) : `${first}–${last}`;
}

/** "10 seasons" — every season the show has, owned or not; specials aren't
 *  a season. Null when that's none. */
export function seasonsLabel(seasonNumbers: number[]): string | null {
  const n = seasonNumbers.filter((s) => s !== 0).length;
  if (n === 0) return null;
  return n === 1 ? "1 season" : `${n} seasons`;
}

// Seasons and episodes in words, as every app says them (Mark, 24 Sep
// 2026): "Season 2, Episode 8", not "S2 E8" or "S02E08"; season 0 is
// "Specials" / "Special 3". The apps' twin is MediaVaultKit's EpisodeWording.

/** "Season 2, Episode 8", or "Special 3". */
export function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return seasonNumber === 0 ? `Special ${episodeNumber}` : `Season ${seasonNumber}, Episode ${episodeNumber}`;
}

/** What the season menu calls a season: "Season 2", or "Specials". */
export function seasonLabel(seasonNumber: number): string {
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

/** The Play button: "Resume – Season 2, Episode 8", "Play – Special 3". */
export function playLabel(seasonNumber: number, episodeNumber: number, resuming: boolean): string {
  return `${resuming ? "Resume" : "Play"} – ${episodeCode(seasonNumber, episodeNumber)}`;
}

export interface GenreTagged {
  id: number;
  title: string;
  genres: string[];
}

/** The show page's More like this: other shows sharing any of its genres,
 *  most genres in common first, then by title. `candidates` is what the
 *  viewer may open (getShows, age-gated); those with nothing on disk are
 *  the caller's to drop. */
export function similarShows<T extends GenreTagged>(
  show: { id: number; genres: string[] },
  candidates: T[],
  max = 12,
): T[] {
  if (show.genres.length === 0) return [];
  const wanted = new Set(show.genres);
  return candidates
    .filter((c) => c.id !== show.id)
    .map((c) => ({ c, shared: c.genres.filter((g) => wanted.has(g)).length }))
    .filter((r) => r.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.c.title.localeCompare(b.c.title))
    .slice(0, max)
    .map(({ c }) => c);
}
