// Home's card labels and links (home-cards.ts) — the same words the Apple
// TV puts on its cards.
import { describe, expect, it } from "vitest";
import {
  collectionLine,
  episodeLine,
  episodeProgress,
  filmBadges,
  homeCard,
  meaningfulEpisodeName,
  rowExpands,
} from "./home-cards";
import type { HomeCollection, HomeEpisode, HomeFilm } from "./home-rows";

const film = {
  id: 3,
  title: "Heat",
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  logoPath: "/l.png",
  bestTier: { label: "4K", rank: 0 },
} as HomeFilm;

const episode: HomeEpisode = {
  episodeFileId: 40,
  show: { id: 9, title: "Lost", posterPath: "/sp.jpg" },
  seasonNumber: 2,
  episodeNumber: 4,
  name: "Everybody Hates Hugo",
  stillPath: "/still.jpg",
  positionSecs: 600,
  durationSecs: 2400,
  playable: true,
  showBackdropPath: null,
  showLogoPath: "/sl.png",
  year: 2005,
  certification: "15",
  runtimeLabel: "43m",
  genres: ["Drama"],
  overview: null,
};

const collection: HomeCollection = {
  id: 5,
  name: "Bond",
  overview: null,
  posterPath: null,
  backdropPath: null,
  filmIds: [3, 4],
  years: "1962–2021",
};

describe("labels", () => {
  it("drops TMDB's placeholder episode names", () => {
    expect(meaningfulEpisodeName("Episode 8", 8)).toBeNull();
    expect(meaningfulEpisodeName("  ", 8)).toBeNull();
    expect(meaningfulEpisodeName("Episode 8", 9)).toBe("Episode 8");
    expect(meaningfulEpisodeName("Pilot", 1)).toBe("Pilot");
  });

  it("names an episode by series and number, then its name", () => {
    expect(episodeLine(episode)).toBe("Series 2, Episode 4 · Everybody Hates Hugo");
    expect(episodeLine({ ...episode, name: "episode 4" })).toBe("Series 2, Episode 4");
  });

  it("summarises a collection", () => {
    expect(collectionLine(6, "1962–2021")).toBe("6 films · 1962–2021");
    expect(collectionLine(1, null)).toBe("1 film");
  });

  it("badges a film with why it's here, then Ultra HD for a 4K copy", () => {
    expect(filmBadges(film, "continueWatching")).toEqual(["Continue Watching", "Ultra HD"]);
    expect(filmBadges({ bestTier: { label: "1080p", rank: 2 } }, "recentlyAdded")).toEqual(["Recently Added"]);
    expect(filmBadges({ bestTier: { label: "1080p", rank: 2 } }, null)).toEqual([]);
  });

  it("shows progress only once an episode is properly under way", () => {
    expect(episodeProgress(600, 2400)).toBe(0.25);
    expect(episodeProgress(20, 2400)).toBeNull();
    expect(episodeProgress(600, null)).toBeNull();
    expect(episodeProgress(3000, 2400)).toBe(1);
  });
});

describe("homeCard", () => {
  it("links a film to its page with its artwork", () => {
    expect(homeCard({ kind: "film", filmId: 3, reason: null }, { 3: film })).toMatchObject({
      key: "film-3",
      href: "/film/3",
      backdropPath: "/b.jpg",
      logoPath: "/l.png",
      badges: ["Ultra HD"],
    });
    expect(homeCard({ kind: "film", filmId: 99, reason: null }, { 3: film })).toBeNull();
  });

  it("links an episode to its show, falling back to the still for a backdrop", () => {
    expect(homeCard({ kind: "episode", episode }, {})).toMatchObject({
      href: "/shows/9",
      title: "Lost",
      backdropPath: "/still.jpg",
      logoPath: "/sl.png",
      badges: ["S2 E4"],
      progress: 0.25,
    });
  });

  it("lends a collection its first film's art when it has none", () => {
    expect(homeCard({ kind: "collection", collection }, { 3: film })).toMatchObject({
      href: "/collections/5",
      posterPath: "/p.jpg",
      backdropPath: "/b.jpg",
      badges: ["2 films"],
    });
  });

  it("links an album to its page", () => {
    const album = { id: 7, title: "OK Computer", year: 1997, kind: "STUDIO", artistId: 1, artistName: "Radiohead", hasCover: true, coverVersion: 1 };
    expect(homeCard({ kind: "album", album }, {})?.href).toBe("/music/album/7");
  });
});

describe("rowExpands", () => {
  it("opens film, episode and collection rows, not shows or music", () => {
    expect(rowExpands([{ kind: "film", filmId: 3, reason: null }, { kind: "episode", episode }])).toBe(true);
    expect(rowExpands([{ kind: "album", album: { id: 7, title: "", year: null, kind: "", artistId: 1, artistName: "", hasCover: false, coverVersion: null } }])).toBe(false);
  });
});
