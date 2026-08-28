import { describe, expect, it } from "vitest";
import { parseUpcItemDbResponse } from "./barcode-lookup";

describe("parseUpcItemDbResponse", () => {
  it("returns null with no items", () => {
    expect(parseUpcItemDbResponse({ items: [] })).toBeNull();
    expect(parseUpcItemDbResponse({})).toBeNull();
  });

  it("returns null when the item has no title", () => {
    expect(parseUpcItemDbResponse({ items: [{}] })).toBeNull();
  });

  it("extracts a bracketed year and strips it from the title", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix [1999]" }] })).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("extracts a parenthesised year", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix (1999)" }] })).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("strips format tags like (Blu-ray) even with no year present", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix (Blu-ray)" }] })).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("strips bracketed studio/UPC noise", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix [Warner Bros]" }] })).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("returns null if stripping leaves nothing", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "(DVD)" }] })).toBeNull();
  });
});
