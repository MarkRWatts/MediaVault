import { describe, expect, it } from "vitest";
import { pickItunesHit, verifyArtistMatch } from "./cover-art";

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
