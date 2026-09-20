import { describe, expect, it } from "vitest";
import { sharedSpec } from "./episode-specs";
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

describe("sharedSpec", () => {
  it("summarises a boxed set — every file the same rip", () => {
    const spec = sharedSpec([file({ id: 1 }), file({ id: 2 }), file({ id: 3 })]);
    expect(spec).not.toBeNull();
    expect(spec!.format).toBe("DVD");
    expect(spec!.resolution).toBe("720×576");
    expect(spec!.audio).toHaveLength(1);
    expect(spec!.audio[0]).toMatchObject({ label: "Dolby Digital", sublabel: "5.1" });
  });

  it("refuses to summarise when the files disagree", () => {
    // A show half-ripped from DVD, half from Blu-ray.
    expect(sharedSpec([file(), file({ format: "BLURAY" })])).toBeNull();
    // Same disc format, different resolution.
    expect(sharedSpec([file(), file({ resolution: "1920×1080" })])).toBeNull();
    // One episode's rip carries HDR.
    expect(sharedSpec([file(), file({ videoRange: "HDR10" })])).toBeNull();
    // Same codec, different channel layout.
    expect(
      sharedSpec([
        file(),
        file({
          audioTracks: [
            { id: 2, codec: "ac3", profile: null, channels: 2, layout: "stereo", language: "eng", title: null },
          ],
        }),
      ]),
    ).toBeNull();
    // An extra commentary track on one file only.
    expect(
      sharedSpec([
        file(),
        file({
          audioTracks: [
            ...file().audioTracks,
            { id: 3, codec: "ac3", profile: null, channels: 2, layout: "stereo", language: "eng", title: "Commentary" },
          ],
        }),
      ]),
    ).toBeNull();
  });

  it("distinguishes object audio — an Atmos rip is not the same spec", () => {
    const atmos = file({
      audioTracks: [
        { id: 4, codec: "truehd", profile: "Dolby TrueHD + Dolby Atmos", channels: 8, layout: "7.1", language: "eng", title: null },
      ],
    });
    expect(sharedSpec([atmos, atmos])!.audio[0].objectAudio).toBe("atmos");
    expect(sharedSpec([file(), atmos])).toBeNull();
  });

  it("falls back to the legacy summary string, and still compares it", () => {
    const legacy = file({ audioTracks: [], audioSummary: "Dolby Digital · Stereo · ENG" });
    const spec = sharedSpec([legacy, { ...legacy, id: 2 }]);
    expect(spec!.audio).toHaveLength(0);
    expect(spec!.audioSummary).toBe("Dolby Digital · Stereo · ENG");
    // A file with real tracks isn't interchangeable with one that has only
    // the string, even when they describe the same audio.
    expect(sharedSpec([legacy, file()])).toBeNull();
  });

  it("has nothing to say about an episode with no files", () => {
    expect(sharedSpec([])).toBeNull();
  });
});
