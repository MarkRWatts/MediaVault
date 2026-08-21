import { describe, expect, it } from "vitest";
import { parseEpisodePath, parseShowFolder } from "./parse-tv";

// Real paths from the share's TV Shows folder (plus reductions).
describe("parseEpisodePath", () => {
  it("padded season folder", () => {
    const p = parseEpisodePath("Game of Thrones (2011)/Season 01/Game of Thrones S01E01.mkv");
    expect(p).toMatchObject({
      showTitle: "Game of Thrones",
      showYear: 2011,
      showFolder: "Game of Thrones (2011)",
      season: 1,
      episodes: [1],
      container: "mkv",
    });
  });

  it("unpadded season folder", () => {
    const p = parseEpisodePath("Rome (2005)/Season 1/Rome S01E03.mkv");
    expect(p).toMatchObject({ showTitle: "Rome", showYear: 2005, season: 1, episodes: [3] });
  });

  it("flat show folder with trailing year (Firefly)", () => {
    const p = parseEpisodePath("Firefly (2002)/Firefly S01E14 (2002).mkv");
    expect(p).toMatchObject({ showTitle: "Firefly", showYear: 2002, season: 1, episodes: [14] });
  });

  it("loose episode directly in show folder", () => {
    const p = parseEpisodePath("Downton Abbey (2010)/Downton Abbey S02E09.mkv");
    expect(p).toMatchObject({ showTitle: "Downton Abbey", season: 2, episodes: [9] });
  });

  it("multi-episode range", () => {
    const p = parseEpisodePath("Rome (2005)/Season 2/Rome S02E01-E02.mkv");
    expect(p).toMatchObject({ season: 2, episodes: [1, 2] });
  });

  it("season folder wins over a mismatched code", () => {
    const p = parseEpisodePath("Rome (2005)/Season 2/Rome S01E05.mkv");
    expect(p?.season).toBe(2);
  });

  it("rejects files without an episode code", () => {
    expect(parseEpisodePath("Rome (2005)/Season 1/extras.mkv")).toBeNull();
    expect(parseEpisodePath("loose-file.mkv")).toBeNull();
  });
});

describe("parseShowFolder", () => {
  it("extracts title and year", () => {
    expect(parseShowFolder("Downton Abbey (2010)")).toEqual({ title: "Downton Abbey", year: 2010 });
    expect(parseShowFolder("The Wire")).toEqual({ title: "The Wire", year: null });
  });
});
