// What one card on Home shows, whatever kind of thing it is — the web's
// half of the Apple TV's TVPick (MediaVaultiOS, TVHomePicks.swift): where it
// links, which artwork it wears as a poster and which when it opens wide,
// the title artwork over the backdrop, the little badges in its corner and
// an episode's progress bar. Pure, so the labels are tested without a
// browser (home-cards.test.ts); components/home draws them.
//
// Films, episodes and collections open wide (the TV's three kinds); shows
// and albums, which the TV's Home doesn't have, stay posters and covers.

import type { HomeData, HomeEpisode, HomeFilm, HomeItem, HomeReason } from "@/lib/home-rows";

export interface HomeCard {
  /** Unique within a row: "film-12", "episode-340", "collection-7"… */
  key: string;
  href: string;
  title: string;
  posterPath: string | null;
  /** The open card's artwork; falls back to the poster (cropped) when a
   *  title has no backdrop. */
  backdropPath: string | null;
  /** TMDB title artwork, a transparent PNG; null draws the title as text. */
  logoPath: string | null;
  /** White-on-dark pills over the open card: why it's here, "Ultra HD". */
  badges: string[];
  /** 0…1 along the bottom — an episode you're partway through. */
  progress: number | null;
}

const REASON_LABELS: Record<HomeReason, string> = {
  continueWatching: "Continue Watching",
  recentlyAdded: "Recently Added",
};

/** Episodes TMDB hasn't named yet come back as "Episode 8", which only
 *  repeats the number beside it. */
export function meaningfulEpisodeName(name: string | null, episodeNumber: number): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase() === `episode ${episodeNumber}` ? null : trimmed;
}

/** Under an open episode: "Series 2, Episode 4 · The Constant". */
export function episodeLine(episode: Pick<HomeEpisode, "seasonNumber" | "episodeNumber" | "name">): string {
  const name = meaningfulEpisodeName(episode.name, episode.episodeNumber);
  return `Series ${episode.seasonNumber}, Episode ${episode.episodeNumber}${name ? ` · ${name}` : ""}`;
}

/** "6 films · 1962–2021" (or without the years when none is known). */
export function collectionLine(filmCount: number, years: string | null): string {
  const films = `${filmCount} film${filmCount === 1 ? "" : "s"}`;
  return years ? `${films} · ${years}` : films;
}

/** Only past the first half-minute, as the players' resume point is — a
 *  sliver of bar for something barely started is noise. */
export function episodeProgress(positionSecs: number, durationSecs: number | null): number | null {
  if (!durationSecs || durationSecs <= 0 || positionSecs <= 30) return null;
  return Math.min(positionSecs / durationSecs, 1);
}

export function filmBadges(film: Pick<HomeFilm, "bestTier">, reason: HomeReason | null): string[] {
  const out: string[] = [];
  if (reason) out.push(REASON_LABELS[reason]);
  if (film.bestTier.rank === 0) out.push("Ultra HD");
  return out;
}

/** The card for one of a row's items, or null for a film the payload
 *  doesn't carry (it never should — buildHomeRows sends every one it names). */
export function homeCard(item: HomeItem, films: HomeData["films"]): HomeCard | null {
  switch (item.kind) {
    case "film": {
      const film = films[item.filmId];
      if (!film) return null;
      return {
        key: `film-${film.id}`,
        href: `/film/${film.id}`,
        title: film.title,
        posterPath: film.posterPath,
        backdropPath: film.backdropPath,
        logoPath: film.logoPath,
        badges: filmBadges(film, item.reason),
        progress: null,
      };
    }
    case "episode": {
      const e = item.episode;
      return {
        key: `episode-${e.episodeFileId}`,
        href: `/shows/${e.show.id}`,
        title: e.show.title,
        posterPath: e.show.posterPath,
        backdropPath: e.showBackdropPath ?? e.stillPath,
        logoPath: e.showLogoPath,
        badges: [`S${e.seasonNumber} E${e.episodeNumber}`],
        progress: episodeProgress(e.positionSecs, e.durationSecs),
      };
    }
    case "collection": {
      const c = item.collection;
      // A collection without art of its own borrows its first film's, as
      // the TV does — when that film travelled in `films` (it has if it's
      // in any other row).
      const first = c.filmIds.map((id) => films[id]).find(Boolean);
      return {
        key: `collection-${c.id}`,
        href: `/collections/${c.id}`,
        title: c.name,
        posterPath: c.posterPath ?? first?.posterPath ?? null,
        backdropPath: c.backdropPath ?? first?.backdropPath ?? null,
        logoPath: null,
        badges: [`${c.filmIds.length} films`],
        progress: null,
      };
    }
    case "show":
      return {
        key: `show-${item.show.id}`,
        href: `/shows/${item.show.id}`,
        title: item.show.title,
        posterPath: item.show.posterPath,
        backdropPath: item.show.backdropPath,
        logoPath: item.show.logoPath,
        badges: [],
        progress: null,
      };
    case "album":
      return {
        key: `album-${item.album.id}`,
        href: `/music/album/${item.album.id}`,
        title: item.album.title,
        posterPath: null,
        backdropPath: null,
        logoPath: null,
        badges: [],
        progress: null,
      };
  }
}

/** Whether a row's cards open wide: films, episodes and collections do;
 *  New Shows and New Music are plain posters and covers. */
export function rowExpands(items: HomeItem[]): boolean {
  return items.every((i) => i.kind === "film" || i.kind === "episode" || i.kind === "collection");
}
