import { describe, expect, it } from "vitest";
import { searchMatches } from "@/lib/search-match";

describe("searchMatches", () => {
  it("matches the start of any word, ignoring case and accents", () => {
    expect(searchMatches("amelie", "Amélie")).toBe(true);
    expect(searchMatches("bourne ult", "The Bourne Ultimatum")).toBe(true);
    expect(searchMatches("ULTIMATUM", "The Bourne Ultimatum")).toBe(true);
  });

  it("does not match the middle of a word", () => {
    expect(searchMatches("ace", "Ace of Base")).toBe(true);
    expect(searchMatches("ace", "Peace")).toBe(false);
    expect(searchMatches("ace", "Graceland")).toBe(false);
  });

  it("needs every word, but from any field", () => {
    expect(searchMatches("abba gold", "Gold", "ABBA")).toBe(true);
    expect(searchMatches("abba silver", "Gold", "ABBA")).toBe(false);
    expect(searchMatches("bourne", "The Bourne Identity", null)).toBe(true);
  });

  it("treats an empty query as matching everything", () => {
    expect(searchMatches("  ", "Anything")).toBe(true);
  });
});
