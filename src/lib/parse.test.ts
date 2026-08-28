import { describe, expect, it } from "vitest";
import { filmKey, normalizeTitle, parseFileName, sortTitle } from "./parse";

// Every case here is a real path from the share (or a minimal reduction of one).
describe("parseFileName", () => {
  it("plain name + year", () => {
    const p = parseFileName("Gladiator (2000).mkv");
    expect(p).toMatchObject({ title: "Gladiator", year: 2000, folder: null, container: "mkv" });
  });

  it("resolution tag", () => {
    const p = parseFileName("Interstellar (2014) [1080p].mkv");
    expect(p).toMatchObject({ title: "Interstellar", year: 2014, resolutionTag: 1080 });
  });

  it("imdb id + resolution", () => {
    const p = parseFileName("Die Hard (1988) [imdbid-tt0095016] [1080p].mkv");
    expect(p).toMatchObject({ title: "Die Hard", year: 1988, imdbId: "tt0095016", resolutionTag: 1080 });
  });

  it("edition + imdb + resolution (Alien set)", () => {
    const p = parseFileName("Alien (1979) [2003 Directors Cut] [imdbid-tt0078748] [1080p].mkv");
    expect(p).toMatchObject({
      title: "Alien",
      year: 1979,
      edition: "2003 Directors Cut",
      imdbId: "tt0078748",
      resolutionTag: 1080,
    });
  });

  it("tag glued to year with no space", () => {
    const p = parseFileName("James Bond 007/License to Kill (1989)[imdbid-tt0097742].mkv");
    expect(p).toMatchObject({ title: "License to Kill", year: 1989, imdbId: "tt0097742", folder: "James Bond 007" });
  });

  it("stray dash before tags", () => {
    const p = parseFileName("James Bond 007/Casino Royale (2006) - [1080p].mkv");
    expect(p).toMatchObject({ title: "Casino Royale", year: 2006, resolutionTag: 1080 });
  });

  it("tmdb id", () => {
    const p = parseFileName(
      "The Lord of the Rings Collection/The Lord of the Rings The Fellowship of the Ring (2001) - [Extended Edition] [tmdbid-120].mkv"
    );
    expect(p).toMatchObject({ title: "The Lord of the Rings The Fellowship of the Ring", year: 2001, tmdbId: 120, edition: "Extended Edition" });
  });

  it("no year at all", () => {
    const p = parseFileName("Serenity.mkv");
    expect(p).toMatchObject({ title: "Serenity", year: null });
  });

  it("underscores as spaces", () => {
    const p = parseFileName("The_A-Team.mkv");
    expect(p).toMatchObject({ title: "The A-Team", year: null });
  });

  it("year-glued typo extension", () => {
    const p = parseFileName("Girl with a Pearl Earring (2003)mkv.mkv");
    expect(p).toMatchObject({ title: "Girl with a Pearl Earring", year: 2003 });
  });

  it("parenthesised edition", () => {
    const p = parseFileName("Monty Python and the Holy Grail (Special Edition) (1975) [imdbid-tt0071853].mkv");
    expect(p).toMatchObject({ title: "Monty Python and the Holy Grail", year: 1975, edition: "Special Edition", imdbId: "tt0071853" });
  });

  it("digits-first title with parenthesised year", () => {
    const p = parseFileName("2001 A Space Odyssey (1968).mkv");
    expect(p).toMatchObject({ title: "2001 A Space Odyssey", year: 1968 });
  });

  it("bare year inside title", () => {
    const p = parseFileName("Blade Runner 2049 (2017) [imdbid-tt1856101] [1080p].mkv");
    expect(p).toMatchObject({ title: "Blade Runner 2049", year: 2017, imdbId: "tt1856101" });
  });

  it("nested film folder keeps top-level collection folder", () => {
    const p = parseFileName("Indiana Jones/Raiders of the Lost Ark (1981)/Indiana Jones and the Raiders of the Lost Ark (1981).mkv");
    expect(p).toMatchObject({ title: "Indiana Jones and the Raiders of the Lost Ark", year: 1981, folder: "Indiana Jones" });
  });

  it("accented titles survive", () => {
    const p = parseFileName("Léon The Professional (1994).mkv");
    expect(p.title).toBe("Léon The Professional");
  });
});

describe("filmKey", () => {
  it("groups editions of the same film by imdb id", () => {
    const a = parseFileName("Alien (1979) [2003 Directors Cut] [imdbid-tt0078748] [1080p].mkv");
    const b = parseFileName("Alien (1979) [Theatrical Release] [imdbid-tt0078748] [1080p].mkv");
    expect(filmKey(a)).toBe(filmKey(b));
  });

  it("groups by normalised title+year without ids", () => {
    const a = parseFileName("Night At the Museum 2 (2009).mkv");
    const b = parseFileName("Night at the Museum 2 (2009).mkv");
    expect(filmKey(a)).toBe(filmKey(b));
  });

  it("does not merge different years of same title", () => {
    const a = parseFileName("Total Recall (1990).mkv");
    const b = parseFileName("Total Recall (2012) [1080p].mkv");
    expect(filmKey(a)).not.toBe(filmKey(b));
  });
});

describe("sortTitle", () => {
  it("strips leading article and accents", () => {
    expect(sortTitle("The Matrix")).toBe("matrix");
    expect(sortTitle("Léon The Professional")).toBe("leon the professional");
  });
});

describe("normalizeTitle", () => {
  it("treats & as equivalent to 'and' — a barcode-derived title using one must still match TMDB's using the other", () => {
    expect(normalizeTitle("Ant Man & The Wasp")).toBe(normalizeTitle("Ant-Man and the Wasp"));
    expect(normalizeTitle("Fast & Furious 6")).toBe("fast and furious 6");
  });
});
