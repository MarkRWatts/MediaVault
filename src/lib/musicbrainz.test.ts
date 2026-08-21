import { describe, expect, it } from "vitest";
import {
  artistNameVariants,
  classifyAlbumKind,
  escapeLucene,
  normalizeAlbumTitle,
  parseReleaseDate,
} from "./musicbrainz";

describe("classifyAlbumKind", () => {
  it("Album with no secondary types -> STUDIO", () => {
    expect(classifyAlbumKind("Album", [])).toBe("STUDIO");
    expect(classifyAlbumKind("Album", undefined)).toBe("STUDIO");
  });

  it("EP primary -> EP", () => {
    expect(classifyAlbumKind("EP", [])).toBe("EP");
  });

  it("secondary types take priority over Album primary", () => {
    expect(classifyAlbumKind("Album", ["Compilation"])).toBe("COMPILATION");
    expect(classifyAlbumKind("Album", ["Live"])).toBe("LIVE");
    expect(classifyAlbumKind("Album", ["Remix"])).toBe("REMIX");
    expect(classifyAlbumKind("Album", ["Soundtrack"])).toBe("SOUNDTRACK");
  });

  it("is case-insensitive", () => {
    expect(classifyAlbumKind("album", ["live"])).toBe("LIVE");
  });

  it("first matching secondary type wins by priority order (Compilation over Live)", () => {
    expect(classifyAlbumKind("Album", ["Live", "Compilation"])).toBe("COMPILATION");
  });

  it("unrecognised primary type with no matching secondary -> OTHER", () => {
    expect(classifyAlbumKind("Broadcast", [])).toBe("OTHER");
    expect(classifyAlbumKind(null, null)).toBe("OTHER");
  });

  it("never classifies as SINGLE (excluded by the search query, defensive fallback only)", () => {
    expect(classifyAlbumKind("Single", [])).toBe("OTHER");
  });
});

describe("normalizeAlbumTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeAlbumTitle("Abbey Road!")).toBe("abbey road");
  });

  it("strips diacritics", () => {
    expect(normalizeAlbumTitle("Café del Mar")).toBe("cafe del mar");
  });

  it("strips a trailing bracketed edition tag", () => {
    expect(normalizeAlbumTitle("Fresh Fruit for Rotting Vegetables [EP]")).toBe(
      normalizeAlbumTitle("Fresh Fruit for Rotting Vegetables"),
    );
  });

  it("strips a parenthesised tag anywhere in the title", () => {
    expect(normalizeAlbumTitle("OK Computer (Collector's Edition)")).toBe(normalizeAlbumTitle("OK Computer"));
  });

  it("treats a folder-sanitised underscore the same as a real slash", () => {
    // iTunes can't store "/" in a folder name, so "The Singles 86/98" is
    // saved on disk as "The Singles 86_98" — both must normalize identically
    // for owned-album <-> release-group title matching to work.
    expect(normalizeAlbumTitle("The Singles 86_98")).toBe(normalizeAlbumTitle("The Singles 86/98"));
  });

  it("never strips trailing digits that are part of the real title", () => {
    expect(normalizeAlbumTitle("Optigan 1")).toBe("optigan 1");
  });
});

describe("parseReleaseDate", () => {
  it("full ISO date", () => {
    const { year, releaseDate } = parseReleaseDate("1988-05-02");
    expect(year).toBe(1988);
    expect(releaseDate?.toISOString().slice(0, 10)).toBe("1988-05-02");
  });

  it("year-month only", () => {
    const { year, releaseDate } = parseReleaseDate("1988-05");
    expect(year).toBe(1988);
    expect(releaseDate?.toISOString().slice(0, 10)).toBe("1988-05-01");
  });

  it("year only", () => {
    const { year, releaseDate } = parseReleaseDate("1988");
    expect(year).toBe(1988);
    expect(releaseDate?.toISOString().slice(0, 10)).toBe("1988-01-01");
  });

  it("null/empty/malformed input yields no year or date", () => {
    expect(parseReleaseDate(null)).toEqual({ year: null, releaseDate: null });
    expect(parseReleaseDate(undefined)).toEqual({ year: null, releaseDate: null });
    expect(parseReleaseDate("")).toEqual({ year: null, releaseDate: null });
    expect(parseReleaseDate("not-a-date")).toEqual({ year: null, releaseDate: null });
  });
});

describe("artistNameVariants", () => {
  it("returns just the name when there's nothing to reverse", () => {
    expect(artistNameVariants("Radiohead")).toEqual(["Radiohead"]);
  });

  it("adds a reversed-sanitisation fallback for underscore/semicolon", () => {
    expect(artistNameVariants("AC_DC")).toEqual(["AC_DC", "AC/DC"]);
    expect(artistNameVariants("Erik Satie; Anne Queffelec")).toEqual([
      "Erik Satie; Anne Queffelec",
      "Erik Satie: Anne Queffelec",
    ]);
  });
});

describe("escapeLucene", () => {
  it("escapes double quotes and backslashes for a quoted phrase", () => {
    expect(escapeLucene('Guns N\' Roses "Live"')).toBe('Guns N\' Roses \\"Live\\"');
    expect(escapeLucene("back\\slash")).toBe("back\\\\slash");
  });
});
