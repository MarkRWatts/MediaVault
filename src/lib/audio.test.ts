import { describe, expect, it } from "vitest";
import { audioBadge, audioFamily } from "./audio";

describe("audioBadge", () => {
  it("labels the Dolby family", () => {
    expect(audioBadge("ac3", null, 6, "5.1(side)")).toMatchObject({ label: "Dolby Digital", sublabel: "5.1" });
    expect(audioBadge("eac3", null, 8, "7.1")).toMatchObject({ label: "Dolby Digital Plus", sublabel: "7.1" });
    expect(audioBadge("truehd", null, 8, "7.1")).toMatchObject({ label: "Dolby TrueHD", sublabel: "7.1" });
  });

  it("flags object audio from the profile without losing the base codec", () => {
    // Real probe data off the share: ffprobe puts Atmos and DTS:X in the
    // profile, alongside the core codec that's actually carrying them, and
    // the badge keeps naming that core.
    expect(audioBadge("truehd", "Dolby TrueHD + Dolby Atmos", 8, "7.1")).toMatchObject({
      label: "Dolby TrueHD",
      sublabel: "7.1",
      objectAudio: "atmos",
    });
    expect(audioBadge("eac3", "Dolby Digital Plus + Dolby Atmos", 6, "5.1(side)")).toMatchObject({
      label: "Dolby Digital Plus",
      objectAudio: "atmos",
    });
    // Fast & Furious 8's Blu-ray — the library's only DTS:X disc.
    expect(audioBadge("dts", "DTS-HD MA + DTS:X", 8, "7.1")).toMatchObject({
      label: "DTS-HD MA",
      objectAudio: "dtsx",
    });
    expect(audioBadge("truehd", null, 8, "7.1").objectAudio).toBeNull();
    expect(audioBadge("ac3", null, 6, "5.1(side)").objectAudio).toBeNull();
    expect(audioBadge("dts", "DTS-HD MA", 6, "5.1(side)").objectAudio).toBeNull();
    // DTS Express carries an X in its name and is not DTS:X.
    expect(audioBadge("dts", "DTS Express", 2, "stereo").objectAudio).toBeNull();
  });

  it("distinguishes DTS profiles — the whole point of this module", () => {
    // Real Die Hard (1988) probe data: two DTS tracks, one HD MA, one plain.
    expect(audioBadge("dts", "DTS-HD MA", 6, "5.1(side)")).toMatchObject({ label: "DTS-HD MA" });
    expect(audioBadge("dts", "DTS", 6, "5.1(side)")).toMatchObject({ label: "DTS" });
    expect(audioBadge("dts", "DTS-HD HRA", 8, "7.1")).toMatchObject({ label: "DTS-HD HRA" });
    expect(audioBadge("dts", "DTS-ES", 6, "5.1")).toMatchObject({ label: "DTS-ES" });
    expect(audioBadge("dts", null, 6, "5.1")).toMatchObject({ label: "DTS" });
  });

  it("labels the plain/lossless codecs", () => {
    expect(audioBadge("aac", null, 2, "stereo")).toMatchObject({ label: "AAC", sublabel: "Stereo" });
    expect(audioBadge("flac", null, 2, "stereo")).toMatchObject({ label: "FLAC" });
    expect(audioBadge("mp3", null, 2, "stereo")).toMatchObject({ label: "MP3" });
    expect(audioBadge("pcm_s16le", null, 2, "stereo")).toMatchObject({ label: "PCM" });
    expect(audioBadge("opus", null, 2, "stereo")).toMatchObject({ label: "Opus" });
    expect(audioBadge("vorbis", null, 2, "stereo")).toMatchObject({ label: "Vorbis" });
  });

  it("falls back to the uppercased codec name for anything unrecognised", () => {
    expect(audioBadge("wmapro", null, 2, null)).toMatchObject({ label: "WMAPRO" });
  });

  it("derives channel sublabels from the layout tag, tolerating ffprobe's parenthetical suffixes", () => {
    expect(audioBadge("ac3", null, 6, "5.1(side)").sublabel).toBe("5.1");
    expect(audioBadge("ac3", null, 2, "stereo").sublabel).toBe("Stereo");
    expect(audioBadge("ac3", null, 1, "mono").sublabel).toBe("Mono");
  });

  it("falls back to channel count when layout is missing", () => {
    expect(audioBadge("ac3", null, 6, null).sublabel).toBe("5.1");
    expect(audioBadge("ac3", null, 2, null).sublabel).toBe("Stereo");
    expect(audioBadge("ac3", null, 1, null).sublabel).toBe("Mono");
    expect(audioBadge("ac3", null, 8, null).sublabel).toBe("7.1");
  });

  it("handles missing codec/channel data gracefully", () => {
    expect(audioBadge(null, null, null, null)).toMatchObject({ label: "Unknown", sublabel: null });
  });
});

describe("audioFamily", () => {
  it("groups Dolby labels together", () => {
    expect(audioFamily("Dolby Digital")).toBe("dolby");
    expect(audioFamily("Dolby Digital Plus")).toBe("dolby");
    expect(audioFamily("Dolby TrueHD")).toBe("dolby");
  });

  it("groups DTS labels together", () => {
    expect(audioFamily("DTS-HD MA")).toBe("dts");
    expect(audioFamily("DTS")).toBe("dts");
    expect(audioFamily("DTS-ES")).toBe("dts");
  });

  it("treats everything else as neutral", () => {
    expect(audioFamily("AAC")).toBe("neutral");
    expect(audioFamily("PCM")).toBe("neutral");
    expect(audioFamily("Unknown")).toBe("neutral");
  });
});
