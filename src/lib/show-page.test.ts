import { describe, expect, it } from "vitest";
import { airYears, episodeCode, seasonLabel, seasonsLabel, similarShows } from "@/lib/show-page";

describe("airYears", () => {
  const seasons = [
    { seasonNumber: 0, airYear: 2011 },
    { seasonNumber: 1, airYear: 1997 },
    { seasonNumber: 2, airYear: 1998 },
    { seasonNumber: 10, airYear: 2007 },
  ];

  it("spans the seasons proper, ignoring a later special", () => {
    expect(airYears(seasons, "Ended", 1997)).toBe("1997–2007");
  });

  it("is one year when the run was", () => {
    expect(airYears([{ seasonNumber: 1, airYear: 2019 }], "Ended", 2019)).toBe("2019");
  });

  it("is left open while the show is still running", () => {
    expect(airYears(seasons, "Returning Series", 1997)).toBe("1997–");
  });

  it("falls back to the show's own year", () => {
    expect(airYears([{ seasonNumber: 1, airYear: null }], null, 2002)).toBe("2002");
    expect(airYears([], null, null)).toBeNull();
  });
});

describe("seasonsLabel", () => {
  it("doesn't count specials", () => {
    expect(seasonsLabel([0, 1, 2, 3])).toBe("3 seasons");
    expect(seasonsLabel([1])).toBe("1 season");
    expect(seasonsLabel([0])).toBeNull();
  });
});

describe("episodeCode and seasonLabel", () => {
  it("reads as the Play button and the menu say them", () => {
    expect(episodeCode(2, 8)).toBe("Season 2, Episode 8");
    expect(episodeCode(0, 3)).toBe("Special 3");
    expect(seasonLabel(1)).toBe("Season 1");
    expect(seasonLabel(0)).toBe("Specials");
  });
});

describe("similarShows", () => {
  const show = { id: 1, genres: ["Sci-Fi & Fantasy", "Action & Adventure"] };
  const all = [
    { id: 1, title: "Stargate SG-1", genres: ["Sci-Fi & Fantasy", "Action & Adventure"] },
    { id: 2, title: "Bluey", genres: ["Kids"] },
    { id: 3, title: "Firefly", genres: ["Sci-Fi & Fantasy", "Western"] },
    { id: 4, title: "Stargate Atlantis", genres: ["Action & Adventure", "Sci-Fi & Fantasy"] },
    { id: 5, title: "Andor", genres: ["Sci-Fi & Fantasy"] },
  ];

  it("ranks by genres in common, then title, leaving out the show itself", () => {
    expect(similarShows(show, all).map((s) => s.id)).toEqual([4, 5, 3]);
  });

  it("stops at max, and finds nothing for a show with no genres", () => {
    expect(similarShows(show, all, 2).map((s) => s.id)).toEqual([4, 5]);
    expect(similarShows({ id: 9, genres: [] }, all)).toEqual([]);
  });
});
