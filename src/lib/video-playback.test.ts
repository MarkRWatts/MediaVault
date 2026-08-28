import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, planVideoPlayback } from "./video-playback";

describe("planVideoPlayback", () => {
  it("returns null when the file hasn't been probed yet", () => {
    expect(planVideoPlayback({ videoCodec: null, container: "mkv", audioTracks: [] })).toBeNull();
  });

  it("direct-plays h264/aac already in an mp4", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mp4",
      audioTracks: [{ streamIdx: 1, codec: "aac", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({
      tier: "direct",
      videoAction: "copy",
      audioAction: "copy",
      audioStreamIndex: 1,
      hevcTag: false,
    });
  });

  it("direct-plays a video-only mp4 with no audio tracks", () => {
    const plan = planVideoPlayback({ videoCodec: "h264", container: "mp4", audioTracks: [] });
    expect(plan).toMatchObject({ tier: "direct", audioAction: "none", audioStreamIndex: null });
  });

  it("remuxes h264+ac3 out of an mkv without touching either stream", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "copy", audioAction: "copy", audioStreamIndex: 1 });
  });

  it("picks a compatible track over an incompatible one regardless of stream order", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "truehd", profile: null, channels: 8 },
        { streamIdx: 2, codec: "ac3", profile: null, channels: 6 },
      ],
    });
    expect(plan).toMatchObject({ tier: "prepare", audioAction: "copy", audioStreamIndex: 2, hevcTag: true });
  });

  it("tags hevc copies with hvc1 for Apple compatibility", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "aac", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "copy", hevcTag: true });
  });

  it("transcodes audio when nothing compatible exists, preferring the lossless/highest-channel source", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8 },
        { streamIdx: 2, codec: "dts", profile: null, channels: 6 }, // plain DTS core, fewer channels
      ],
    });
    expect(plan).toMatchObject({ tier: "prepare", audioAction: "transcode", audioStreamIndex: 1 });
  });

  it("prefers higher channel count over lossless-ness when they conflict", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 2 }, // lossless but stereo
        { streamIdx: 2, codec: "truehd", profile: null, channels: 8 }, // also lossless, more channels
      ],
    });
    expect(plan).toMatchObject({ audioAction: "transcode", audioStreamIndex: 2 });
  });

  it("transcodes mpeg-2 (DVD) video even when audio is already compatible", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "transcode", audioAction: "copy", hevcTag: false });
  });

  it("is case-insensitive on codec and container", () => {
    const plan = planVideoPlayback({
      videoCodec: "H264",
      container: "MP4",
      audioTracks: [{ streamIdx: 1, codec: "AAC", profile: null, channels: 2 }],
    });
    expect(plan?.tier).toBe("direct");
  });
});

describe("buildFfmpegArgs", () => {
  it("copies both streams for a plain remux", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args).toEqual([
      "-y",
      "-i",
      "/in.mkv",
      "-map",
      "0:v:0",
      "-map",
      "0:1",
      "-map_chapters",
      "-1",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+delay_moov+default_base_moof+negative_cts_offsets",
      "-f",
      "mp4",
      "/out.mp4",
    ]);
  });

  it("caps transcoded audio at 6 channels and picks a bitrate off the output channel count", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "truehd", profile: null, channels: 8 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan, 8);
    expect(args).toContain("-tag:v");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ac", "6", "-b:a", "384k"]));
  });

  it("adds a video encode when the source codec is unsupported", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "vob",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    const args = buildFfmpegArgs("/in.vob", "/out.mp4", plan);
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]));
  });

  // Regression: copying an AC-3 track (the common case -- AC-3 is already
  // "compatible", so it's copied rather than transcoded) into an empty_moov
  // fragmented MP4 fails outright without delay_moov -- ffmpeg can't write
  // even an empty moov before it's seen an AC-3 packet to learn the frame
  // size from. Confirmed against a real file: "Cannot write moov atom before
  // AC3 packets" without this flag, clean output with it.
  it("always includes delay_moov, required for a copied AC-3 track to mux at all", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    const movflags = args[args.indexOf("-movflags") + 1];
    expect(movflags.split("+")).toContain("delay_moov");
  });

  // Regression: a source chapter track (very common on DVD/Blu-ray rips) gets
  // auto-converted into an extra QuickTime chapter text track by the mov
  // muxer unless chapters are explicitly dropped. That stray track broke
  // playback outright in a fragmented MP4 -- confirmed against a real file
  // where Safari reported a duration but rendered no video or audio at all
  // until this flag was added.
  it("always drops chapters, to avoid an auto-inserted chapter track breaking fragmented playback", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args[args.indexOf("-map_chapters") + 1]).toBe("-1");
  });

  // Regression: a copied H.264 stream with B-frames (the common case) played
  // audio but rendered no video at all in Safari, because the fragmented
  // empty_moov/delay_moov path doesn't survive edit-list-based composition
  // timing -- confirmed against a real file.
  it("always includes negative_cts_offsets, required for B-frame video to render in the fragmented path", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    const movflags = args[args.indexOf("-movflags") + 1];
    expect(movflags.split("+")).toContain("negative_cts_offsets");
  });

  // A real transcode is CPU-bound and this runs as a background job on a
  // small box that also has to keep serving the app -- letting libx264 claim
  // every core starves everything else.
  it("caps libx264 to 2 threads so a transcode doesn't monopolize the host", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args[args.indexOf("-threads") + 1]).toBe("2");
  });
});
