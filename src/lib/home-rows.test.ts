// Home's rows (buildHomeRows) from hand-made inputs — no database: which
// rows, in what order, with what in them.
import { describe, expect, it } from "vitest";
import { buildHomeRows, MIN_GENRE_FILMS, TOP_PICKS, type HomeEpisode, type HomeFilm, type HomeInputs, type HomeItem } from "./home-rows";
import type { PlayableCollection, ShowSummary } from "./queries";

function film(id: number, over: Partial<HomeFilm> = {}): HomeFilm {
  return {
    id,
    title: `Film ${id}`,
    sortTitle: `film ${id}`,
    year: 2000 + id,
    certification: null,
    posterPath: null,
    backdropPath: null,
    logoPath: null,
    genres: [],
    collectionId: null,
    collectionName: null,
    collectionPosterPath: null,
    releaseDate: null,
    createdAt: `2026-01-${String(id).padStart(2, "0")}T00:00:00.000Z`,
    owned: true,
    formats: [],
    discCount: 1,
    bestTier: { label: "1080p", rank: 2 },
    videoCodecs: [],
    audioFormats: [],
    physicalMedia: [],
    overview: null,
    runtimeLabel: "",
    ...over,
  };
}

function episode(fileId: number, showId: number, playable = true): HomeEpisode {
  return {
    episodeFileId: fileId,
    show: { id: showId, title: `Show ${showId}`, posterPath: null },
    seasonNumber: 1,
    episodeNumber: 2,
    name: null,
    stillPath: null,
    positionSecs: 600,
    durationSecs: 2400,
    playable,
    showBackdropPath: null,
    showLogoPath: null,
    year: 2011,
    certification: "PG",
    runtimeLabel: "1h 5m",
    genres: ["Drama"],
    overview: null,
  };
}

function show(id: number, ownedEpisodeCount: number, createdAt: string): ShowSummary {
  return {
    id,
    title: `Show ${id}`,
    sortTitle: `show ${id}`,
    year: null,
    posterPath: null,
    backdropPath: null,
    logoPath: null,
    certification: null,
    ownedEpisodeCount,
    totalEpisodeCount: 10,
    complete: false,
    createdAt,
    genres: [],
  };
}

function inputs(over: Partial<HomeInputs>): HomeInputs {
  return { films: [], continueWatching: [], favourites: [], collections: [], episodes: [], shows: null, albums: null, ...over };
}

const ids = (items: HomeItem[]) =>
  items.map((i) => (i.kind === "film" ? `film-${i.filmId}` : i.kind === "episode" ? `episode-${i.episode.episodeFileId}` : i.kind));

describe("buildHomeRows", () => {
  it("leads Top Picks with what you're partway through, then episodes, then the newest — each once", () => {
    const films = [film(1), film(2), film(3)];
    const home = buildHomeRows(
      inputs({ films, continueWatching: [films[0]], episodes: [episode(50, 7), episode(51, 7), episode(52, 8, false)] }),
    );
    expect(home.rows[0].id).toBe("top-picks");
    expect(ids(home.rows[0].items)).toEqual(["film-1", "episode-50", "film-3", "film-2"]);
    expect(home.rows[0].items[0]).toMatchObject({ reason: "continueWatching" });
    expect(home.rows[0].items[2]).toMatchObject({ reason: "recentlyAdded" });
  });

  it("stops Top Picks at its limit and leaves out films you don't have", () => {
    const films = Array.from({ length: 20 }, (_, i) => film(i + 1));
    films.push(film(99, { owned: false }));
    const home = buildHomeRows(inputs({ films, continueWatching: [films[20]] }));
    expect(home.rows[0].items).toHaveLength(TOP_PICKS);
    expect(ids(home.rows[0].items)).not.toContain("film-99");
    expect(home.films[99]).toBeUndefined();
  });

  it("orders rows Top Picks, Favourites, Collections, genres (biggest first), New Shows, New Music", () => {
    const films = [
      ...Array.from({ length: MIN_GENRE_FILMS + 1 }, (_, i) => film(i + 1, { genres: ["Action"] })),
      ...Array.from({ length: MIN_GENRE_FILMS }, (_, i) => film(i + 20, { genres: ["Comedy"] })),
      ...Array.from({ length: MIN_GENRE_FILMS - 1 }, (_, i) => film(i + 40, { genres: ["Horror"] })),
    ];
    const bond: PlayableCollection = { id: 645, name: "Bond", overview: null, posterPath: null, backdropPath: null, filmIds: [3, 1, 999] };
    const home = buildHomeRows(
      inputs({
        films,
        favourites: [films[4]],
        collections: [bond],
        shows: [show(1, 3, "2026-02-01T00:00:00.000Z"), show(2, 0, "2026-03-01T00:00:00.000Z")],
        albums: [{ id: 5, title: "Album", year: 2020, kind: "ALBUM", artistId: 1, artistName: "Artist", hasCover: false, coverVersion: null }],
      }),
    );
    expect(home.rows.map((r) => r.title)).toEqual(["Top Picks", "Favourites", "Collections", "Action", "Comedy", "New Shows", "New Music"]);
    // Newest additions lead a genre row.
    expect(ids(home.rows[3].items)[0]).toBe(`film-${MIN_GENRE_FILMS + 1}`);
    // A collection keeps only the films you have, and says when they span.
    expect(home.rows[2].items[0]).toMatchObject({ collection: { filmIds: [3, 1], years: "2001–2003" } });
    // A show with nothing to watch isn't new to you.
    expect(home.rows[5].items).toHaveLength(1);
  });

  it("drops a collection with fewer than two of your films, and empty rows", () => {
    const home = buildHomeRows(
      inputs({ films: [film(1)], collections: [{ id: 1, name: "Pair", overview: null, posterPath: null, backdropPath: null, filmIds: [1, 2] }] }),
    );
    expect(home.rows.map((r) => r.id)).toEqual(["top-picks"]);
  });

  it("sends each film once however many rows it's in", () => {
    const films = Array.from({ length: MIN_GENRE_FILMS }, (_, i) => film(i + 1, { genres: ["Action", "Drama"] }));
    const home = buildHomeRows(inputs({ films, favourites: [films[0]] }));
    expect(Object.keys(home.films)).toHaveLength(MIN_GENRE_FILMS);
  });
});
