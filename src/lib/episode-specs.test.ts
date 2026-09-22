import { describe, expect, it } from "vitest";
import { sharedSpec, specExcept, fileSpec } from "./episode-specs";
import type { EpisodeFileView } from "./queries";

function file(over: Partial<EpisodeFileView> = {}): EpisodeFileView {
  return {
    id: 1,
    format: "DVD",
    width: 720,
    height: 576,
    resolution: "720×576",
    tier: { rank: 1, label: "576p" } as EpisodeFileView["tier"],
    videoRange: "SDR",
    audioTracks: [
      { id: 1, codec: "ac3", profile: null, channels: 6, layout: "5.1(side)", language: "eng", title: null },
    ],
    audioSummary: "Dolby Digital · 5.1 · ENG",
    sizeLabel: "1.4 GB",
    jellyfinId: null,
    videoCodec: "h264",
    ...over,
  };
}

const stereo: Partial<EpisodeFileView> = {
  audioTracks: [
    { id: 9, codec: "ac3", profile: null, channels: 2, layout: "stereo", language: "eng", title: null },
  ],
};

describe("sharedSpec", () => {
  it("summarises a boxed set — every file the same rip", () => {
    const spec = sharedSpec([file({ id: 1 }), file({ id: 2 }), file({ id: 3 })])!;
    expect(spec.format).toBe("DVD");
    expect(spec.resolution).toBe("720×576");
    expect(spec.videoRange).toBe("SDR");
    expect(spec.audio!.tracks).toHaveLength(1);
    expect(spec.audio!.tracks[0]).toMatchObject({ label: "Dolby Digital", sublabel: "5.1" });
  });

  it("keeps the fields that agree when only the audio differs", () => {
    // Sharpe: eighteen DVD files at one resolution, two of them 5.1 among
    // sixteen stereo. The header still says DVD and the resolution.
    const spec = sharedSpec([file(), file({ id: 2, ...stereo }), file({ id: 3, ...stereo })])!;
    expect(spec.format).toBe("DVD");
    expect(spec.resolution).toBe("720×576");
    expect(spec.audio).toBeNull();
  });

  it("keeps the fields that agree when only the format differs", () => {
    // A show half-ripped from DVD, half from Blu-ray, mastered the same way
    // otherwise — rare, but the resolution and audio are still true of both.
    const spec = sharedSpec([file(), file({ id: 2, format: "BLURAY" })])!;
    expect(spec.format).toBeNull();
    expect(spec.resolution).toBe("720×576");
    expect(spec.audio!.tracks[0]).toMatchObject({ label: "Dolby Digital" });
  });

  it("hoists nothing when the files agree on nothing", () => {
    const spec = sharedSpec([
      file(),
      file({ id: 2, format: "UHD", resolution: "3840×2160", videoRange: "HDR10", ...stereo }),
    ])!;
    expect(spec).toEqual({ format: null, resolution: null, videoRange: null, audio: null });
  });

  it("summarises a single file in full", () => {
    const spec = sharedSpec([file()])!;
    expect(spec.format).toBe("DVD");
    expect(spec.resolution).toBe("720×576");
    expect(spec.audio!.tracks).toHaveLength(1);
  });

  it("distinguishes object audio — an Atmos rip is not the same spec", () => {
    const atmos = file({
      audioTracks: [
        { id: 4, codec: "truehd", profile: "Dolby TrueHD + Dolby Atmos", channels: 8, layout: "7.1", language: "eng", title: null },
      ],
    });
    expect(sharedSpec([atmos, atmos])!.audio!.tracks[0].objectAudio).toBe("atmos");
    expect(sharedSpec([file(), atmos])!.audio).toBeNull();
  });

  it("counts an extra commentary track as a difference", () => {
    const withCommentary = file({
      id: 2,
      audioTracks: [
        ...file().audioTracks,
        { id: 3, codec: "ac3", profile: null, channels: 2, layout: "stereo", language: "eng", title: "Commentary" },
      ],
    });
    expect(sharedSpec([file(), withCommentary])!.audio).toBeNull();
  });

  it("falls back to the legacy summary string, and still compares it", () => {
    const legacy = file({ audioTracks: [], audioSummary: "Dolby Digital · Stereo · ENG" });
    const spec = sharedSpec([legacy, { ...legacy, id: 2 }])!;
    expect(spec.audio!.tracks).toHaveLength(0);
    expect(spec.audio!.summary).toBe("Dolby Digital · Stereo · ENG");
    // A file with real tracks isn't interchangeable with one that has only
    // the string, even when they describe the same audio.
    expect(sharedSpec([legacy, file()])!.audio).toBeNull();
  });

  it("has nothing to say about an episode with no files", () => {
    expect(sharedSpec([])).toBeNull();
  });
});

describe("specExcept", () => {
  it("drops exactly the fields the header hoisted", () => {
    const hoisted = sharedSpec([file(), file({ id: 2, ...stereo })]);
    const row = specExcept(fileSpec(file({ ...stereo })), hoisted);
    // DVD and the resolution were said above; the audio wasn't.
    expect(row.format).toBeNull();
    expect(row.resolution).toBeNull();
    expect(row.audio!.tracks[0]).toMatchObject({ sublabel: "Stereo" });
  });

  it("leaves a row's whole spec alone when nothing was hoisted", () => {
    expect(specExcept(fileSpec(file()), null)).toEqual(fileSpec(file()));
  });
});
