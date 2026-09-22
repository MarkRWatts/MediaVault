import { describe, expect, it } from "vitest";
import { initialOpenSeason } from "./season-collapse";

describe("initialOpenSeason", () => {
  it("leaves a single-season show open", () => {
    expect(initialOpenSeason([1], null)).toBe(1);
  });

  it("opens the season the Play button points into", () => {
    expect(initialOpenSeason([0, 1, 2, 3], 3)).toBe(3);
    // Everything watched but the specials — the button offers one, so that
    // is the season to open, specials or not.
    expect(initialOpenSeason([0, 1, 2], 0)).toBe(0);
  });

  it("falls back to the first real season when nothing is playable", () => {
    expect(initialOpenSeason([0, 1, 2], null)).toBe(1);
  });

  it("has no season to open for a show with none", () => {
    expect(initialOpenSeason([], null)).toBeNull();
  });
});
