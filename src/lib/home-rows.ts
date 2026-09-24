// Home — the same front page on the web ("/"), the iPhone and the Apple TV:
// rows to browse rather than one long list. Decided here, once, so every
// app shows exactly the same rows in the same order; each draws them its own
// way (the TV widens the focused card, the web the hovered one, the iPhone
// leads with a carousel of Top Picks).
//
//   Top Picks    films you're partway through, then episodes, then the
//                newest films — up to TOP_PICKS
//   Favourites   your hearted films
//   Collections  those with two or more films you have
//   <genre>      one row per genre with at least MIN_GENRE_FILMS films,
//                biggest first, newest additions leading each row
//   New shows    when the server has TV
//   New music    when the server has music
//
// buildHomeRows is the decision, from data already fetched (tested without a
// database); getHomeRows fetches it. Rows name films by id and the films
// travel once, in `films`, so one that's in three genres isn't sent thrice.

import { prisma } from "@/lib/db";
import type { AgeLimit } from "@/lib/age-rating";
import {
  formatRuntimeMins,
  getContinueWatchingEpisodes,
  getContinueWatchingFilms,
  getFavouriteFilms,
  getLibraryFilms,
  getPlayableCollections,
  getShows,
  type ContinueEpisode,
  type LibraryFilm,
  type PlayableCollection,
  type ShowSummary,
} from "@/lib/queries";
import { getRecentAlbums, type FavouriteAlbumView } from "@/lib/queries-music";

export const TOP_PICKS = 10;
export const MIN_GENRE_FILMS = 6;
export const NEW_SHOWS = 12;
export const NEW_MUSIC = 12;

/** A film card plus what a row's details line needs: what it's about and
 *  how long it is. */
export interface HomeFilm extends LibraryFilm {
  overview: string | null;
  runtimeLabel: string;
}

/** A continue-watching episode, with its show's wide artwork for the open
 *  card (the episode's own still is small and often absent). */
export interface HomeEpisode extends ContinueEpisode {
  showBackdropPath: string | null;
  showLogoPath: string | null;
}

export interface HomeCollection extends PlayableCollection {
  /** "1962–2021", or one year, or null when none of its films has one. */
  years: string | null;
}

/** Why a film is in Top Picks — the open card's badge. */
export type HomeReason = "continueWatching" | "recentlyAdded";

export type HomeItem =
  | { kind: "film"; filmId: number; reason: HomeReason | null }
  | { kind: "episode"; episode: HomeEpisode }
  | { kind: "collection"; collection: HomeCollection }
  | { kind: "show"; show: ShowSummary }
  | { kind: "album"; album: FavouriteAlbumView };

export interface HomeRow {
  /** Stable across loads: "top-picks", "favourites", "collections",
   *  "genre-Action", "new-shows", "new-music". */
  id: string;
  title: string;
  items: HomeItem[];
}

export interface HomeData {
  rows: HomeRow[];
  /** Every film a row names, by id. */
  films: Record<number, HomeFilm>;
}

export interface HomeInputs {
  /** Every film in the library the viewer may see (owned or not). */
  films: HomeFilm[];
  continueWatching: LibraryFilm[];
  favourites: LibraryFilm[];
  collections: PlayableCollection[];
  episodes: HomeEpisode[];
  /** Null when the server has no TV library. */
  shows: ShowSummary[] | null;
  /** Null when the server has no music library. */
  albums: FavouriteAlbumView[] | null;
}

export function buildHomeRows(input: HomeInputs): HomeData {
  const owned = input.films.filter((f) => f.owned);
  const byId = new Map(owned.map((f) => [f.id, f]));
  const used = new Map<number, HomeFilm>();
  const film = (id: number, reason: HomeReason | null): HomeItem | null => {
    const f = byId.get(id);
    if (!f) return null;
    used.set(id, f);
    return { kind: "film", filmId: id, reason };
  };
  const rows: HomeRow[] = [];
  const push = (id: string, title: string, items: (HomeItem | null)[]) => {
    const present = items.filter((i): i is HomeItem => i !== null);
    if (present.length > 0) rows.push({ id, title, items: present });
  };
  const newestFirst = [...owned].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Top Picks: each title once.
  const picks: (HomeItem | null)[] = [];
  const picked = new Set<number>();
  for (const f of input.continueWatching) {
    if (byId.has(f.id) && !picked.has(f.id)) {
      picked.add(f.id);
      picks.push(film(f.id, "continueWatching"));
    }
  }
  const pickedShows = new Set<number>();
  for (const episode of input.episodes) {
    if (episode.playable && !pickedShows.has(episode.show.id)) {
      pickedShows.add(episode.show.id);
      picks.push({ kind: "episode", episode });
    }
  }
  for (const f of newestFirst) {
    if (!picked.has(f.id)) {
      picked.add(f.id);
      picks.push(film(f.id, "recentlyAdded"));
    }
  }
  push("top-picks", "Top Picks", picks.slice(0, TOP_PICKS));

  push("favourites", "Favourites", input.favourites.map((f) => film(f.id, null)));

  push(
    "collections",
    "Collections",
    input.collections.map((c): HomeItem | null => {
      const members = c.filmIds.filter((id) => byId.has(id));
      if (members.length < 2) return null;
      const years = members.map((id) => byId.get(id)!.year).filter((y): y is number => y !== null);
      const first = years.length ? Math.min(...years) : null;
      const last = years.length ? Math.max(...years) : null;
      return {
        kind: "collection",
        collection: {
          ...c,
          filmIds: members,
          years: first === null ? null : first === last ? String(first) : `${first}–${last}`,
        },
      };
    }),
  );

  const byGenre = new Map<string, HomeFilm[]>();
  for (const f of newestFirst) {
    for (const genre of f.genres) byGenre.set(genre, [...(byGenre.get(genre) ?? []), f]);
  }
  const genres = [...byGenre.entries()]
    .filter(([, members]) => members.length >= MIN_GENRE_FILMS)
    .sort(([a, am], [b, bm]) => bm.length - am.length || a.localeCompare(b));
  for (const [genre, members] of genres) {
    push(`genre-${genre}`, genre, members.map((f) => film(f.id, null)));
  }

  if (input.shows) {
    const newShows = input.shows
      .filter((s) => s.ownedEpisodeCount > 0)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, NEW_SHOWS);
    push("new-shows", "New Shows", newShows.map((show) => ({ kind: "show", show })));
  }
  if (input.albums) {
    push("new-music", "New Music", input.albums.slice(0, NEW_MUSIC).map((album) => ({ kind: "album", album })));
  }

  return { rows, films: Object.fromEntries(used) };
}

export async function getHomeRows(
  userId: string,
  limit: AgeLimit,
  features: { tv: boolean; music: boolean },
): Promise<HomeData> {
  const [{ films }, continueWatching, favourites, collections, episodes, shows, albums] = await Promise.all([
    getLibraryFilms(limit),
    getContinueWatchingFilms(userId, limit),
    getFavouriteFilms(userId, limit),
    getPlayableCollections(limit),
    features.tv ? getContinueWatchingEpisodes(userId, limit) : Promise.resolve([]),
    features.tv ? getShows(limit) : Promise.resolve(null),
    features.music ? getRecentAlbums(NEW_MUSIC) : Promise.resolve(null),
  ]);

  // What the list's cards leave out and a row's details line shows.
  const extras = await prisma.film.findMany({
    where: { id: { in: films.filter((f) => f.owned).map((f) => f.id) } },
    select: { id: true, overview: true, runtimeMins: true },
  });
  const extraById = new Map(extras.map((e) => [e.id, e]));
  const homeFilms: HomeFilm[] = films.map((f) => ({
    ...f,
    overview: extraById.get(f.id)?.overview ?? null,
    runtimeLabel: formatRuntimeMins(extraById.get(f.id)?.runtimeMins),
  }));

  const showArt = new Map(
    (shows ?? []).map((s) => [s.id, { backdropPath: s.backdropPath, logoPath: s.logoPath }]),
  );
  const homeEpisodes: HomeEpisode[] = episodes.map((e) => ({
    ...e,
    showBackdropPath: showArt.get(e.show.id)?.backdropPath ?? null,
    showLogoPath: showArt.get(e.show.id)?.logoPath ?? null,
  }));

  return buildHomeRows({
    films: homeFilms,
    continueWatching,
    favourites,
    collections,
    episodes: homeEpisodes,
    shows,
    albums,
  });
}

/** Which libraries this server has — the same answer /api/v1/me gives. */
export function serverFeatures(): { tv: boolean; music: boolean } {
  return { tv: Boolean(process.env.TVSHOWS_PATH), music: Boolean(process.env.MUSIC_PATH) };
}
