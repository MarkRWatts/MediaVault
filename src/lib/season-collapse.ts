// Which season a show page unfolds for someone who has never opened it
// before (once they fold or unfold one themselves, useCollapsed remembers
// that instead). A seven-season set is thirty screens of episode rows if
// every season is open, and the shape of the show — how many seasons, how
// much of each is on disk — is what the page is for.

/** The season to leave open on a first visit, or null for a show with no
 *  seasons at all. `nextSeasonNumber` is where the page's Play / Continue
 *  button points (getNextEpisodeFile). */
export function initialOpenSeason(
  seasonNumbers: number[],
  nextSeasonNumber: number | null,
): number | null {
  if (seasonNumbers.length === 0) return null;
  // Nothing to fold away, and folding it would leave a page with no
  // episodes on it.
  if (seasonNumbers.length === 1) return seasonNumbers[0];
  if (nextSeasonNumber !== null) return nextSeasonNumber;
  // No playable file to point at (playback off, or nothing on disk yet), so
  // open the season a run starts in — specials (season 0) last of all.
  return seasonNumbers.find((n) => n !== 0) ?? seasonNumbers[0];
}
