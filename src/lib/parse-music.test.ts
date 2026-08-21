import { describe, expect, it } from "vitest";
import { parseAlbumFolder, parseArtistFolder, parseTrackFileName, parseTrackPath } from "./parse-music";

// Every case here is a real (or minimally reduced) file/folder name from the
// share's Music folder — see SPEC-MUSIC.md "Facts about the real data".
describe("parseTrackFileName", () => {
  it("plain track number", () => {
    const p = parseTrackFileName("01 Life Is A Flower.m4a");
    expect(p).toMatchObject({ disc: 1, trackNumber: 1, title: "Life Is A Flower", ext: "m4a", codecHint: null });
  });

  it("disc-track prefix", () => {
    const p = parseTrackFileName("1-01 Just Another Space Odyssey.m4a");
    expect(p).toMatchObject({ disc: 1, trackNumber: 1, title: "Just Another Space Odyssey" });
  });

  it("disc 2 track 11", () => {
    const p = parseTrackFileName("2-11 Crockett's Theme.m4a");
    expect(p).toMatchObject({ disc: 2, trackNumber: 11, title: "Crockett's Theme" });
  });

  it("Bandcamp dash-glued title with underscores", () => {
    const p = parseTrackFileName("07-Le_Carnaval_des_Etoiles.mp3");
    expect(p).toMatchObject({ disc: 1, trackNumber: 7, title: "Le Carnaval des Etoiles", ext: "mp3" });
  });

  it("title with a trailing digit is never stripped (Optigan 1)", () => {
    const p = parseTrackFileName("13 Optigan 1.m4a");
    expect(p).toMatchObject({ trackNumber: 13, title: "Optigan 1" });
  });

  it("title with a trailing digit is never stripped (We Come 1)", () => {
    const p = parseTrackFileName("06 We Come 1.m4a");
    expect(p).toMatchObject({ trackNumber: 6, title: "We Come 1" });
  });

  it("m4p is FairPlay DRM — codec hint drm", () => {
    const p = parseTrackFileName("03 Some Song.m4p");
    expect(p).toMatchObject({ trackNumber: 3, title: "Some Song", ext: "m4p", codecHint: "drm" });
  });

  it("no leading track number — trackNumber null, title is the basename", () => {
    const p = parseTrackFileName("Hidden Track.m4a");
    expect(p).toMatchObject({ disc: 1, trackNumber: null, title: "Hidden Track", ext: "m4a" });
  });
});

describe("parseAlbumFolder", () => {
  it("trailing bracket tag becomes the edition tag", () => {
    const p = parseAlbumFolder("Kring Havet - Meren Ympärillä [EP]");
    expect(p).toEqual({ title: "Kring Havet - Meren Ympärillä", editionTag: "EP" });
  });

  it("non-bracket suffix is left in the title as-is", () => {
    const p = parseAlbumFolder("Live in Oslo - DVD");
    expect(p).toEqual({ title: "Live in Oslo - DVD", editionTag: null });
  });
});

describe("parseArtistFolder", () => {
  it("is a passthrough (trimmed)", () => {
    expect(parseArtistFolder("Kebu")).toEqual({ name: "Kebu" });
    expect(parseArtistFolder(" Frank Zappa ")).toEqual({ name: "Frank Zappa" });
  });
});

describe("parseTrackPath", () => {
  it("assembles artist/album/track from a full relative path", () => {
    const p = parseTrackPath("Kebu/Trip to the Aquarium/01 Life Is A Flower.m4a");
    expect(p).toMatchObject({
      artistFolder: "Kebu",
      artistName: "Kebu",
      albumFolder: "Trip to the Aquarium",
      albumTitle: "Trip to the Aquarium",
      albumEditionTag: null,
      disc: 1,
      trackNumber: 1,
      title: "Life Is A Flower",
      ext: "m4a",
    });
  });

  it("carries the album edition tag through", () => {
    const p = parseTrackPath("Kring Tiganus/Kring Havet - Meren Ympärillä [EP]/01 Intro.m4a");
    expect(p).toMatchObject({ albumTitle: "Kring Havet - Meren Ympärillä", albumEditionTag: "EP" });
  });

  it("disc-track path (Miami Vice style)", () => {
    const p = parseTrackPath("Jan Hammer/Miami Vice/2-11 Crockett's Theme.m4a");
    expect(p).toMatchObject({ disc: 2, trackNumber: 11, title: "Crockett's Theme" });
  });

  it("Bandcamp path", () => {
    const p = parseTrackPath("Igorrr/Savage Sinusoid/07-Le_Carnaval_des_Etoiles.mp3");
    expect(p).toMatchObject({ trackNumber: 7, title: "Le Carnaval des Etoiles" });
  });

  it("m4p DRM file carries the codec hint through", () => {
    const p = parseTrackPath("Some Artist/Some Album/03 Some Song.m4p");
    expect(p).toMatchObject({ ext: "m4p", codecHint: "drm" });
  });

  it("returns null for a path that isn't Artist/Album/file", () => {
    expect(parseTrackPath("loose-file.mp3")).toBeNull();
  });
});
