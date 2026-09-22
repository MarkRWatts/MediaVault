import { describe, expect, it } from "vitest";
import { matchesFormat, type FormatFilterable } from "./library-filters";
import type { Format } from "./constants";

/** A film with nothing but the three fields the predicate reads. `rank` 9
 *  is resolutionTier's "unknown width", i.e. no 4K rip. */
function film(formats: Format[], physicalMedia: Format[] = [], rank = 9): FormatFilterable {
  return { formats, physicalMedia, bestTier: { label: "?", rank } };
}

describe("matchesFormat", () => {
  it("matches a ripped version of that format", () => {
    expect(matchesFormat(film(["BLURAY"]), "BLURAY")).toBe(true);
    expect(matchesFormat(film(["BLURAY"]), "DVD")).toBe(false);
  });

  it("matches a disc you own but haven't ripped", () => {
    expect(matchesFormat(film([], ["DVD"]), "DVD")).toBe(true);
  });

  it("matches both when a film is owned on one and ripped from the other", () => {
    const both = film(["BLURAY"], ["DVD"]);
    expect(matchesFormat(both, "BLURAY")).toBe(true);
    expect(matchesFormat(both, "DVD")).toBe(true);
    expect(matchesFormat(both, "UHD")).toBe(false);
  });

  it("does not promote an HD or SD rip to a disc format", () => {
    expect(matchesFormat(film(["HD"]), "BLURAY")).toBe(false);
    expect(matchesFormat(film(["SD"]), "DVD")).toBe(false);
    expect(matchesFormat(film(["UNKNOWN"]), "DVD")).toBe(false);
  });

  it("counts a 4K-resolution rip as UltraHD however its format was classified", () => {
    // Agrees with formatSectionFor, which shelves this film under 4K.
    expect(matchesFormat(film(["UNKNOWN"], [], 0), "UHD")).toBe(true);
    expect(matchesFormat(film(["UNKNOWN"], [], 0), "BLURAY")).toBe(false);
  });

  it("does not count resolution towards Blu-ray or DVD", () => {
    expect(matchesFormat(film([], [], 0), "BLURAY")).toBe(false);
  });

  it("matches nothing for a film with no formats at all", () => {
    expect(matchesFormat(film([]), "UHD")).toBe(false);
    expect(matchesFormat(film([]), "BLURAY")).toBe(false);
    expect(matchesFormat(film([]), "DVD")).toBe(false);
  });
});
