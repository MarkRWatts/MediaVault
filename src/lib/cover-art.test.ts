import { describe, expect, it } from "vitest";
import { copyForAlbumCover, pickItunesHit, verifyArtistMatch } from "./cover-art";

describe("verifyArtistMatch", () => {
  it("accepts an exact match", () => {
    expect(verifyArtistMatch("Erasure", "Erasure")).toBe(true);
  });

  it("is case-insensitive and diacritics-insensitive", () => {
    expect(verifyArtistMatch("ERASURE", "erasure")).toBe(true);
    expect(verifyArtistMatch("Café Tacvba", "Cafe Tacvba")).toBe(true);
  });

  it("accepts containment either direction (credit variance)", () => {
    expect(verifyArtistMatch("Erasure feat. Someone", "Erasure")).toBe(true);
    expect(verifyArtistMatch("Erasure", "Erasure feat. Someone")).toBe(true);
  });

  it("rejects the real-world Erasure/Curtis Mayfield mismatch", () => {
    expect(verifyArtistMatch("Curtis Mayfield", "Erasure")).toBe(false);
  });

  it("rejects unrelated artists that happen to share no tokens", () => {
    expect(verifyArtistMatch("Blur", "Radiohead")).toBe(false);
  });

  it("rejects when either side is empty after normalizing", () => {
    expect(verifyArtistMatch("", "Erasure")).toBe(false);
    expect(verifyArtistMatch("Erasure", "")).toBe(false);
    expect(verifyArtistMatch("!!!", "Erasure")).toBe(false);
  });
});

describe("pickItunesHit", () => {
  it("rejects a title-similar hit from the wrong artist (Erasure / Curtis Mayfield)", () => {
    const hits = [
      {
        artistName: "Curtis Mayfield",
        collectionName: "Hits! The Very Best of Curtis Mayfield",
        artworkUrl100: "http://example.com/mayfield.jpg",
      },
    ];
    expect(pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure")).toBeNull();
  });

  it("picks a hit that passes both the artist and title-similarity checks", () => {
    const hits = [
      {
        artistName: "Curtis Mayfield",
        collectionName: "Hits! The Very Best of Curtis Mayfield",
        artworkUrl100: "http://example.com/mayfield.jpg",
      },
      {
        artistName: "Erasure",
        collectionName: "Hits! The Very Best of Erasure",
        artworkUrl100: "http://example.com/erasure.jpg",
      },
    ];
    const best = pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure");
    expect(best?.artworkUrl100).toBe("http://example.com/erasure.jpg");
  });

  it("rejects when title similarity is at or below the 0.6 threshold even with a matching artist", () => {
    const hits = [
      {
        artistName: "Erasure",
        collectionName: "Completely Unrelated Title",
        artworkUrl100: "http://example.com/x.jpg",
      },
    ];
    expect(pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure")).toBeNull();
  });

  it("accepts a title similarity comfortably above 0.6 with a matching artist", () => {
    const hits = [
      {
        artistName: "Erasure",
        collectionName: "Hits! The Very Best of Erasure",
        artworkUrl100: "http://example.com/erasure.jpg",
      },
    ];
    const best = pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure");
    expect(best).not.toBeNull();
  });

  it("returns null when no hit has artwork", () => {
    const hits = [{ artistName: "Erasure", collectionName: "Hits! The Very Best of Erasure" }];
    expect(pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure")).toBeNull();
  });

  it("returns null on an empty hit list", () => {
    expect(pickItunesHit([], "Erasure", "Hits! The Very Best of Erasure")).toBeNull();
  });

  it("picks the higher-similarity hit among two artist-verified candidates", () => {
    const hits = [
      {
        artistName: "Erasure",
        collectionName: "Erasure Live",
        artworkUrl100: "http://example.com/live.jpg",
      },
      {
        artistName: "Erasure",
        collectionName: "Hits! The Very Best of Erasure",
        artworkUrl100: "http://example.com/best-of.jpg",
      },
    ];
    const best = pickItunesHit(hits, "Erasure", "Hits! The Very Best of Erasure");
    expect(best?.artworkUrl100).toBe("http://example.com/best-of.jpg");
  });
});

describe("copyForAlbumCover", () => {
  const cd = (over: Partial<{ discogsReleaseId: number | null; coverPath: string | null; addedAt: Date }> = {}) => ({
    medium: "CD",
    discogsReleaseId: 5824,
    coverPath: "155-cd.jpg",
    addedAt: new Date("2026-08-22"),
    ...over,
  });
  const vinyl = { medium: "VINYL", discogsReleaseId: 99, coverPath: "155-vinyl.jpg", addedAt: new Date("2026-08-23") };
  const album = (over: Partial<{ digitalSource: string | null; coverSource: string | null; hasAlacTracks: boolean }> = {}) => ({
    digitalSource: null,
    coverSource: "discogs",
    hasAlacTracks: true,
    ...over,
  });

  it("takes an ALAC rip's cover from its CD — said or not", () => {
    expect(copyForAlbumCover(album(), [vinyl, cd()])?.medium).toBe("CD");
    expect(copyForAlbumCover(album({ digitalSource: "cd", hasAlacTracks: false }), [cd()])?.medium).toBe("CD");
  });

  it("takes a vinyl download code's cover from its LP", () => {
    expect(copyForAlbumCover(album({ digitalSource: "vinyl-code", hasAlacTracks: false }), [cd(), vinyl])?.medium).toBe("VINYL");
  });

  it("leaves MP3s, downloads and iTunes purchases alone", () => {
    expect(copyForAlbumCover(album({ hasAlacTracks: false }), [cd()])).toBeNull();
    expect(copyForAlbumCover(album({ digitalSource: "itunes" }), [cd()])).toBeNull();
    expect(copyForAlbumCover(album({ digitalSource: "download" }), [cd()])).toBeNull();
  });

  it("never replaces art from the files or set by hand", () => {
    expect(copyForAlbumCover(album({ coverSource: "embedded" }), [cd()])).toBeNull();
    expect(copyForAlbumCover(album({ coverSource: "manual" }), [cd()])).toBeNull();
  });

  it("needs the copy's own edition and cover, and prefers the newest copy", () => {
    expect(copyForAlbumCover(album(), [cd({ discogsReleaseId: null })])).toBeNull();
    expect(copyForAlbumCover(album(), [cd({ coverPath: null })])).toBeNull();
    const older = cd({ coverPath: "old.jpg", addedAt: new Date("2025-01-01") });
    expect(copyForAlbumCover(album(), [older, cd()])?.coverPath).toBe("155-cd.jpg");
  });
});
