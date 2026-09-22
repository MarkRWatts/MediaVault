import { describe, expect, it } from "vitest";
import { enrichConfidenceFilter, isRefreshOnly } from "./tmdb";

describe("enrichConfidenceFilter", () => {
  it("looks only at rows nothing has matched on an ordinary pass", () => {
    expect(enrichConfidenceFilter(false)).toEqual({ in: ["UNMATCHED", "LOW"] });
  });

  it("drops the filter on a forced pass, so matched rows are selected too", () => {
    expect(enrichConfidenceFilter(true)).toBeUndefined();
  });

  it("hands back a fresh array each time — Prisma's where object is not ours to share", () => {
    const first = enrichConfidenceFilter(false)!;
    first.in.push("EXACT");
    expect(enrichConfidenceFilter(false)).toEqual({ in: ["UNMATCHED", "LOW"] });
  });
});

describe("isRefreshOnly", () => {
  it("refreshes a matched row against the id it already holds", () => {
    expect(isRefreshOnly({ tmdbId: 603, matchConfidence: "EXACT" })).toBe(true);
    expect(isRefreshOnly({ tmdbId: 603, matchConfidence: "SEARCH" })).toBe(true);
  });

  it("still matches from scratch where the match is missing or unconfirmed", () => {
    expect(isRefreshOnly({ tmdbId: null, matchConfidence: "UNMATCHED" })).toBe(false);
    expect(isRefreshOnly({ tmdbId: 603, matchConfidence: "LOW" })).toBe(false);
    expect(isRefreshOnly({ tmdbId: 603, matchConfidence: "UNMATCHED" })).toBe(false);
    // Confidence without an id is nothing to refresh against.
    expect(isRefreshOnly({ tmdbId: null, matchConfidence: "EXACT" })).toBe(false);
  });
});
