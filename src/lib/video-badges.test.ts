import { describe, expect, it } from "vitest";
import { resolutionBadge, sharedBadges, videoBadges } from "@/lib/video-badges";

describe("videoBadges", () => {
  it("reads a scope Blu-ray as HD by its width", () => {
    expect(resolutionBadge(1920, 800)).toBe("HD");
    expect(resolutionBadge(3840, 1600)).toBe("Ultra HD");
    expect(resolutionBadge(720, 576)).toBe("SD");
  });

  it("ignores a TrueHD track beside the AAC one that plays", () => {
    // No Time to Die's disc: AAC 5.1 (default) plus TrueHD Atmos 7.1.
    const badges = videoBadges({
      width: 1920,
      height: 800,
      videoRange: "SDR",
      audioTracks: [
        { codec: "aac", channels: 6 },
        { codec: "truehd", channels: 8 },
      ],
    });
    expect(badges).toEqual(["HD", "Surround 5.1"]);
  });

  it("counts a TrueHD-only disc as the 5.1 it is converted to", () => {
    const badges = videoBadges({
      width: 1920,
      height: 1080,
      videoRange: "SDR",
      audioTracks: [{ codec: "truehd", channels: 8 }],
    });
    expect(badges).toEqual(["HD", "Surround 5.1"]);
  });

  it("names HDR and Dolby Vision", () => {
    expect(videoBadges({ width: 3840, height: 2160, videoRange: "HDR10", audioTracks: [] })).toEqual(["Ultra HD", "HDR"]);
    expect(videoBadges({ width: 3840, height: 2160, videoRange: "DOLBY_VISION", audioTracks: [] })).toEqual([
      "Ultra HD",
      "Dolby Vision",
    ]);
  });
});

describe("sharedBadges", () => {
  const dvd = (channels: number) => ({
    width: 720,
    height: 576,
    videoRange: "SDR",
    audioTracks: [{ codec: "ac3", channels }],
  });
  const bluray = { width: 1920, height: 1080, videoRange: "SDR", audioTracks: [{ codec: "ac3", channels: 6 }] };

  it("keeps what every file earns", () => {
    expect(sharedBadges([dvd(6), dvd(6)])).toEqual(["SD", "Surround 5.1"]);
  });

  it("drops what the files disagree about", () => {
    expect(sharedBadges([dvd(2), dvd(2), dvd(6)])).toEqual(["SD"]);
    expect(sharedBadges([dvd(6), bluray])).toEqual(["Surround 5.1"]);
  });

  it("says nothing about no files", () => {
    expect(sharedBadges([])).toEqual([]);
  });
});
