import { describe, expect, it } from "vitest";
import {
  parseDiscogsDuration,
  parseDiscogsTracklist,
  classifyDiscogsKind,
  normalizeBarcode,
  artistNameVariants,
  normalizeAlbumTitle,
} from "./discogs";

describe("parseDiscogsDuration", () => {
  it("parses M:SS", () => {
    expect(parseDiscogsDuration("3:47")).toBe(227);
  });

  it("parses H:MM:SS", () => {
    expect(parseDiscogsDuration("1:02:03")).toBe(3723);
  });

  it("empty/null/undefined yields null", () => {
    expect(parseDiscogsDuration("")).toBeNull();
    expect(parseDiscogsDuration(null)).toBeNull();
    expect(parseDiscogsDuration(undefined)).toBeNull();
  });

  it("unparseable yields null", () => {
    expect(parseDiscogsDuration("not-a-duration")).toBeNull();
  });
});

describe("parseDiscogsTracklist", () => {
  it("parses plain numeric positions as disc 1", () => {
    const tracklist = [
      { position: "1", type_: "track", title: "Intro", duration: "0:22" },
      { position: "2", type_: "track", title: "Second", duration: "7:47" },
    ];
    expect(parseDiscogsTracklist(tracklist)).toEqual([
      { disc: 1, trackNumber: 1, title: "Intro", durationSecs: 22 },
      { disc: 1, trackNumber: 2, title: "Second", durationSecs: 467 },
    ]);
  });

  it("parses letter-prefixed vinyl-side positions as disc number", () => {
    const tracklist = [
      { position: "A1", type_: "track", title: "Side A Track 1", duration: "" },
      { position: "B1", type_: "track", title: "Side B Track 1", duration: "" },
    ];
    expect(parseDiscogsTracklist(tracklist)).toEqual([
      { disc: 1, trackNumber: 1, title: "Side A Track 1", durationSecs: null },
      { disc: 2, trackNumber: 1, title: "Side B Track 1", durationSecs: null },
    ]);
  });

  it("parses box-set disc-track positions (1-1, 2-3)", () => {
    const tracklist = [
      { position: "1-1", type_: "track", title: "Disc 1 Track 1", duration: "3:00" },
      { position: "2-3", type_: "track", title: "Disc 2 Track 3", duration: "4:00" },
    ];
    expect(parseDiscogsTracklist(tracklist)).toEqual([
      { disc: 1, trackNumber: 1, title: "Disc 1 Track 1", durationSecs: 180 },
      { disc: 2, trackNumber: 3, title: "Disc 2 Track 3", durationSecs: 240 },
    ]);
  });

  it("flattens type_:index grouping rows (classical multi-movement works) and skips the heading", () => {
    // Real shape from Anna Lapwood's "Firedove" CD.
    const tracklist = [
      { position: "14", type_: "track", title: "Glass", duration: "4:00" },
      {
        position: "",
        type_: "index",
        title: "Prelude Et Fugue Sur Le Nom D'Alain Op. 7",
        duration: "13:10",
        sub_tracks: [
          { position: "15", type_: "track", title: "I. Prélude", duration: "7:35" },
          { position: "16", type_: "track", title: "II. Fugue", duration: "5:35" },
        ],
      },
    ];
    expect(parseDiscogsTracklist(tracklist)).toEqual([
      { disc: 1, trackNumber: 14, title: "Glass", durationSecs: 240 },
      { disc: 1, trackNumber: 15, title: "I. Prélude", durationSecs: 455 },
      { disc: 1, trackNumber: 16, title: "II. Fugue", durationSecs: 335 },
    ]);
  });

  it("falls back to sequential numbering for an unparseable position", () => {
    const tracklist = [{ position: "???", type_: "track", title: "Mystery", duration: "" }];
    expect(parseDiscogsTracklist(tracklist)).toEqual([
      { disc: 1, trackNumber: 1, title: "Mystery", durationSecs: null },
    ]);
  });

  it("null/undefined/empty tracklist yields an empty list", () => {
    expect(parseDiscogsTracklist(null)).toEqual([]);
    expect(parseDiscogsTracklist(undefined)).toEqual([]);
    expect(parseDiscogsTracklist([])).toEqual([]);
  });
});

describe("normalizeBarcode", () => {
  it("accepts plausible UPC/EAN lengths (8, 12, 13, 14 digits)", () => {
    expect(normalizeBarcode("12345678")).toBe("12345678");
    expect(normalizeBarcode("123456789012")).toBe("123456789012");
    expect(normalizeBarcode("1234567890123")).toBe("1234567890123");
    expect(normalizeBarcode("12345678901234")).toBe("12345678901234");
  });

  it("strips non-digit characters a camera scanner or manual entry might add", () => {
    expect(normalizeBarcode(" 123456789012 \n")).toBe("123456789012");
    expect(normalizeBarcode("123-456-789012")).toBe("123456789012");
  });

  it("rejects implausible lengths", () => {
    expect(normalizeBarcode("123")).toBeNull();
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("1234567890123456789")).toBeNull();
  });
});

describe("artistNameVariants", () => {
  it("returns just the original when no iTunes sanitisation chars are present", () => {
    expect(artistNameVariants("Radiohead")).toEqual(["Radiohead"]);
  });

  it("adds a reversed-sanitisation variant for underscore/semicolon", () => {
    expect(artistNameVariants("AC_DC")).toEqual(["AC_DC", "AC/DC"]);
    expect(artistNameVariants("Various;Artists")).toEqual(["Various;Artists", "Various:Artists"]);
  });
});

describe("normalizeAlbumTitle", () => {
  it("strips bracket/paren tag suffixes before normalizing", () => {
    expect(normalizeAlbumTitle("The Singles 86_98 (Deluxe Edition)")).toBe(normalizeAlbumTitle("The Singles 86/98"));
  });

  it("folds underscore/slash the same as normalizeTitle", () => {
    expect(normalizeAlbumTitle("The Singles 86_98")).toBe(normalizeAlbumTitle("The Singles 86/98"));
  });

  it("keeps the Latin side of a Discogs '<title> = <translated title>' pairing, regardless of which side it's on", () => {
    expect(normalizeAlbumTitle("Flowers = 花朵")).toBe(normalizeAlbumTitle("Flowers"));
    expect(normalizeAlbumTitle("Da Capo = 頭腦靈光")).toBe(normalizeAlbumTitle("Da Capo"));
    // Real case: Jean-Michel Jarre's "Oxygène" master came back from a
    // Discogs search hit titled "幻想惑星 = Oxygene" — native script FIRST.
    expect(normalizeAlbumTitle("幻想惑星 = Oxygene")).toBe(normalizeAlbumTitle("Oxygene"));
  });
});

describe("classifyDiscogsKind", () => {
  it("format descriptor 'Compilation' wins outright", () => {
    expect(classifyDiscogsKind("Anything", "CD, Compilation")).toBe("COMPILATION");
  });

  it("title heuristics catch live/remix/soundtrack (no structured signal from Discogs)", () => {
    expect(classifyDiscogsKind("Live at Wembley", "Vinyl, LP, Album")).toBe("LIVE");
    expect(classifyDiscogsKind("Greatest Hits Remixed", "CD, Album")).toBe("REMIX");
    expect(classifyDiscogsKind("Original Soundtrack", "CD, Album")).toBe("SOUNDTRACK");
  });

  it("format descriptor EP/Album classify when no title heuristic matches", () => {
    expect(classifyDiscogsKind("Untitled", "Vinyl, 12\", EP")).toBe("EP");
    expect(classifyDiscogsKind("Untitled", "CD, Album")).toBe("STUDIO");
  });

  it("no usable signal at all -> OTHER", () => {
    expect(classifyDiscogsKind("Untitled", "Vinyl, 7\", Single")).toBe("OTHER");
    expect(classifyDiscogsKind("Untitled", null)).toBe("OTHER");
  });
});
