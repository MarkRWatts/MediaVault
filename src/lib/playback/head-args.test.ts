import { describe, expect, it } from "vitest";
import { planVideoPlayback, REMOTE_AUDIO_BITRATE, REMOTE_VIDEO_MAXRATE } from "../video-playback";
import { buildHeadArgs, DEFAULT_RENDER_DEVICE, type BuildHeadArgsInput } from "./head-args";
import type { SegmentEntry, SourceFacts } from "./types";

const H264_COPY_PLAN = planVideoPlayback({
  videoCodec: "h264",
  container: "mkv",
  audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
})!;

const HEVC_COPY_PLAN = planVideoPlayback({
  videoCodec: "hevc",
  container: "mkv",
  audioTracks: [{ streamIdx: 1, codec: "eac3", profile: null, channels: 6 }],
})!;

const MPEG2_TRANSCODE_PLAN = planVideoPlayback({
  videoCodec: "mpeg2video",
  container: "vob",
  audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
})!;

const NO_AUDIO_PLAN = planVideoPlayback({ videoCodec: "h264", container: "mkv", audioTracks: [] })!;

const PROGRESSIVE_SOURCE: SourceFacts = { fps: 25, pixFmt: "yuv420p", interlaced: false, width: 1920, height: 1080 };
const INTERLACED_SOURCE: SourceFacts = { fps: 25, pixFmt: "yuv420p", interlaced: true, width: 720, height: 576 };
const TEN_BIT_SOURCE: SourceFacts = { fps: 24, pixFmt: "yuv420p10le", interlaced: false, width: 1920, height: 1080 };

// A three-segment, 2-second-per-cut table -- small enough to reason about
// the relative/absolute arithmetic by hand.
const SEGMENTS: SegmentEntry[] = [
  { index: 0, start: 0, duration: 2 },
  { index: 1, start: 2, duration: 2 },
  { index: 2, start: 4, duration: 2 },
];
const KEYFRAMES_1S = [0, 1, 2, 3, 4, 5, 6];

function baseInput(overrides: Partial<BuildHeadArgsInput> = {}): BuildHeadArgsInput {
  return {
    input: "/media/movies/film.mkv",
    plan: H264_COPY_PLAN,
    variant: "original",
    audio: { streamIndex: H264_COPY_PLAN.audioStreamIndex, action: "copy", sourceChannels: 6 },
    segments: SEGMENTS,
    startIndex: 0,
    outDir: "/cache/film-1/.part-abc",
    hwaccel: "none",
    source: PROGRESSIVE_SOURCE,
    keyframes: KEYFRAMES_1S,
    ...overrides,
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildHeadArgs -- common structure", () => {
  it("starts with the fixed logging/whitelist flags", () => {
    const args = buildHeadArgs(baseInput());
    expect(args.slice(0, 6)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe"]);
  });

  it("maps video and audio, drops chapters and subtitles", () => {
    const args = buildHeadArgs(baseInput());
    expect(argValue(args, "-map_chapters")).toBe("-1");
    expect(args).toContain("-sn");
    const vIdx = args.indexOf("-map");
    expect(args[vIdx + 1]).toBe("0:v:0");
    expect(args).toEqual(expect.arrayContaining(["-map", `0:${H264_COPY_PLAN.audioStreamIndex}`]));
  });

  it("always sets copyts, avoid_negative_ts disabled, and the muxing queue size", () => {
    const args = buildHeadArgs(baseInput());
    expect(args).toContain("-copyts");
    expect(argValue(args, "-avoid_negative_ts")).toBe("disabled");
    expect(argValue(args, "-max_muxing_queue_size")).toBe("2048");
  });

  it("omits the audio map entirely for a file with no audio", () => {
    const args = buildHeadArgs(
      baseInput({ plan: NO_AUDIO_PLAN, audio: { streamIndex: null, action: "none", sourceChannels: null } }),
    );
    const mapIndices = args.reduce<number[]>((acc, a, i) => (a === "-map" ? [...acc, i] : acc), []);
    expect(mapIndices).toHaveLength(1);
    expect(args[mapIndices[0] + 1]).toBe("0:v:0");
    expect(args).not.toContain("-c:a");
  });

  it("ends with the segment muxer output and the output path built from outDir", () => {
    const args = buildHeadArgs(baseInput({ outDir: "/cache/key/.part-xyz" }));
    expect(args[args.length - 1]).toBe("/cache/key/.part-xyz/seg_%05d.ts");
    expect(args).toEqual(
      expect.arrayContaining([
        "-f", "segment",
        "-segment_format", "mpegts",
        "-segment_format_options", "mpegts_copyts=1",
        "-segment_list", "pipe:1",
        "-segment_list_type", "csv",
        "-segment_list_flags", "live",
      ]),
    );
  });

  it("sets -segment_start_number to N", () => {
    const args0 = buildHeadArgs(baseInput({ startIndex: 0 }));
    expect(argValue(args0, "-segment_start_number")).toBe("0");
    const args2 = buildHeadArgs(baseInput({ startIndex: 2 }));
    expect(argValue(args2, "-segment_start_number")).toBe("2");
  });

  it("always includes segment_time_delta and break_non_keyframes", () => {
    const args = buildHeadArgs(baseInput());
    expect(argValue(args, "-segment_time_delta")).toBe("0.02");
    expect(argValue(args, "-break_non_keyframes")).toBe("0");
  });
});

describe("buildHeadArgs -- N=0 and N=last", () => {
  it("N=0: no -ss and no -noaccurate_seek at all", () => {
    const args = buildHeadArgs(baseInput({ startIndex: 0 }));
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-noaccurate_seek");
  });

  it("N=last segment: -segment_times is omitted (no cuts left)", () => {
    const args = buildHeadArgs(baseInput({ startIndex: 2 }));
    expect(args).not.toContain("-segment_times");
  });

  it("N=0 with more segments after it: -segment_times lists every later boundary, relative to segment 0", () => {
    const args = buildHeadArgs(baseInput({ startIndex: 0 }));
    expect(argValue(args, "-segment_times")).toBe("2.000000,4.000000");
  });
});

describe("buildHeadArgs -- relative cut list arithmetic", () => {
  it("cuts are relative to the restarted head's own first packet, not absolute", () => {
    const args = buildHeadArgs(baseInput({ startIndex: 1 }));
    // Only one boundary remains (segment 2 at absolute t=4); relative to
    // segment 1's start (t=2) that's 2.0, not 4.0.
    expect(argValue(args, "-segment_times")).toBe("2.000000");
  });

  it("a longer table produces every remaining relative cut, in order", () => {
    const segments: SegmentEntry[] = [
      { index: 0, start: 0, duration: 5 },
      { index: 1, start: 5, duration: 5 },
      { index: 2, start: 10, duration: 5 },
      { index: 3, start: 15, duration: 5 },
    ];
    const args = buildHeadArgs(baseInput({ segments, startIndex: 1, keyframes: [0, 5, 10, 15, 20] }));
    expect(argValue(args, "-segment_times")).toBe("5.000000,10.000000");
  });
});

describe("buildHeadArgs -- copy-tier video and seeking", () => {
  it("copies h264 video with the h264 annexb bitstream filter", () => {
    const args = buildHeadArgs(baseInput({ plan: H264_COPY_PLAN }));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-bsf:v", "h264_mp4toannexb"]));
  });

  it("copies hevc video with the hevc annexb bitstream filter", () => {
    const args = buildHeadArgs(baseInput({ plan: HEVC_COPY_PLAN, audio: { streamIndex: HEVC_COPY_PLAN.audioStreamIndex, action: HEVC_COPY_PLAN.audioAction as "copy", sourceChannels: 6 } }));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-bsf:v", "hevc_mp4toannexb"]));
  });

  it("N>0 copy: seeks with -noaccurate_seek and keyframe + 0.135s when there's room before the next keyframe", () => {
    // Segment 1 starts at keyframe 2; next keyframe (per KEYFRAMES_1S) is 3 --
    // a full second of room, so the raw offset (2.135) is used unclamped.
    const args = buildHeadArgs(baseInput({ startIndex: 1 }));
    expect(args).toContain("-noaccurate_seek");
    expect(argValue(args, "-ss")).toBe("2.135000");
  });

  it("does not clamp when there's still room before the next keyframe", () => {
    // Next keyframe after 2 is 2.1 -- 0.1s away. The clamp ceiling is
    // 2.1 + (0.13 - 0.005) = 2.225, well above the raw 2.135 target, so the
    // raw offset is used unclamped.
    const segments: SegmentEntry[] = [
      { index: 0, start: 0, duration: 2 },
      { index: 1, start: 2, duration: 0.1 },
      { index: 2, start: 2.1, duration: 2 },
    ];
    const args = buildHeadArgs(baseInput({ segments, startIndex: 1, keyframes: [0, 2, 2.1, 4.1] }));
    expect(argValue(args, "-ss")).toBe("2.135000");
  });

  it("clamps the seek offset when the next keyframe is too close for the raw offset", () => {
    // The clamp only bites once the gap to the next keyframe is smaller
    // than COPY_SEEK_OFFSET_SECS - SEEK_CLAMP_MARGIN_SECS (0.135 - 0.125 =
    // 0.01s) -- a 0.005s gap forces it. Next keyframe after 2 is 2.005;
    // clamp ceiling = 2.005 + 0.125 = 2.13, below the raw 2.135 target, so
    // the clamped value wins.
    const segments: SegmentEntry[] = [
      { index: 0, start: 0, duration: 2 },
      { index: 1, start: 2, duration: 0.005 },
      { index: 2, start: 2.005, duration: 2 },
    ];
    const args = buildHeadArgs(baseInput({ segments, startIndex: 1, keyframes: [0, 2, 2.005, 4.005] }));
    expect(argValue(args, "-ss")).toBe("2.130000");
  });

  it("does not clamp when there is no next keyframe (restarting at the last segment)", () => {
    const args = buildHeadArgs(baseInput({ startIndex: 2, keyframes: [0, 1, 2, 3, 4] }));
    expect(argValue(args, "-ss")).toBe("4.135000");
  });

  it("throws when restarting a copied-video head with no keyframes supplied", () => {
    expect(() => buildHeadArgs(baseInput({ startIndex: 1, keyframes: undefined }))).toThrow(/keyframes/);
    expect(() => buildHeadArgs(baseInput({ startIndex: 1, keyframes: [] }))).toThrow(/keyframes/);
  });
});

describe("buildHeadArgs -- software transcode", () => {
  const transcodeAudio = { streamIndex: MPEG2_TRANSCODE_PLAN.audioStreamIndex, action: "copy" as const, sourceChannels: 2 };

  it("uses libx264 veryfast crf 18 yuv420p 2 threads for Original", () => {
    const args = buildHeadArgs(
      baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, variant: "original", startIndex: 0 }),
    );
    expect(args).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2"]),
    );
    expect(args).not.toContain("-vf");
  });

  it("uses crf 23 and the remote bitrate ceiling, plus the anti-upscale scale filter, for Remote", () => {
    const args = buildHeadArgs(
      baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, variant: "remote", startIndex: 0 }),
    );
    expect(args).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-crf", "23", "-maxrate", REMOTE_VIDEO_MAXRATE, "-bufsize", "6M"]),
    );
    expect(argValue(args, "-vf")).toBe("scale=-2:min(720\\,ih)");
  });

  it("Remote always transcodes video even when the plan says the source video copies", () => {
    const args = buildHeadArgs(baseInput({ plan: H264_COPY_PLAN, variant: "remote", startIndex: 0 }));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264"]));
    expect(args).not.toEqual(expect.arrayContaining(["-c:v", "copy"]));
  });

  it("adds yadif for an interlaced source, ahead of any scale filter", () => {
    const args = buildHeadArgs(
      baseInput({
        plan: MPEG2_TRANSCODE_PLAN,
        audio: transcodeAudio,
        variant: "remote",
        startIndex: 0,
        source: INTERLACED_SOURCE,
      }),
    );
    expect(argValue(args, "-vf")).toBe("yadif,scale=-2:min(720\\,ih)");
  });

  it("forces every future boundary as an absolute time list", () => {
    const args = buildHeadArgs(
      baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, variant: "original", startIndex: 0 }),
    );
    expect(argValue(args, "-force_key_frames")).toBe("2.000000,4.000000");
  });

  it("omits -force_key_frames when restarting at the last segment", () => {
    const args = buildHeadArgs(
      baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, variant: "original", startIndex: 2 }),
    );
    expect(args).not.toContain("-force_key_frames");
  });

  it("N>0 transcode: an accurate seek (no -noaccurate_seek) to the exact absolute boundary", () => {
    const args = buildHeadArgs(
      baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, variant: "original", startIndex: 1 }),
    );
    expect(args).not.toContain("-noaccurate_seek");
    expect(argValue(args, "-ss")).toBe("2.000000");
  });
});

describe("buildHeadArgs -- hardware transcode", () => {
  const transcodeAudio = { streamIndex: MPEG2_TRANSCODE_PLAN.audioStreamIndex, action: "copy" as const, sourceChannels: 2 };

  function hw(overrides: Partial<BuildHeadArgsInput> = {}) {
    return baseInput({ plan: MPEG2_TRANSCODE_PLAN, audio: transcodeAudio, ...overrides });
  }

  it("vaapi Original: hwaccel decode setup, h264_vaapi, -qp 20, GOP from fps", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "original", startIndex: 0 }));
    expect(args).toEqual(
      expect.arrayContaining(["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-vaapi_device", DEFAULT_RENDER_DEVICE]),
    );
    expect(args).toEqual(expect.arrayContaining(["-c:v", "h264_vaapi", "-qp", "20"]));
    expect(argValue(args, "-g")).toBe("150"); // 25fps * 6s
    expect(argValue(args, "-keyint_min")).toBe("150");
  });

  it("vaapi Remote: bitrate ceiling instead of -qp, plus scale_vaapi", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "remote", startIndex: 0 }));
    expect(args).toEqual(
      expect.arrayContaining(["-c:v", "h264_vaapi", "-b:v", REMOTE_VIDEO_MAXRATE, "-maxrate", REMOTE_VIDEO_MAXRATE, "-bufsize", "6M"]),
    );
    expect(args).not.toContain("-qp");
    expect(argValue(args, "-vf")).toBe("scale_vaapi=w=-2:h=min(720\\,ih)");
  });

  it("vaapi interlaced Original: deinterlace_vaapi in the filter chain", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "original", startIndex: 0, source: INTERLACED_SOURCE }));
    expect(argValue(args, "-vf")).toBe("deinterlace_vaapi");
  });

  it("vaapi interlaced Remote: deinterlace before scale, comma-joined", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "remote", startIndex: 0, source: INTERLACED_SOURCE }));
    expect(argValue(args, "-vf")).toBe("deinterlace_vaapi,scale_vaapi=w=-2:h=min(720\\,ih)");
  });

  it("qsv Original: -qsv_device, h264_qsv, -global_quality 20", () => {
    const args = buildHeadArgs(hw({ hwaccel: "qsv", variant: "original", startIndex: 0 }));
    expect(args).toEqual(
      expect.arrayContaining(["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", "-qsv_device", DEFAULT_RENDER_DEVICE]),
    );
    expect(args).toEqual(expect.arrayContaining(["-c:v", "h264_qsv", "-global_quality", "20"]));
  });

  it("qsv Remote: scale_qsv with w=-1 (not -2)", () => {
    const args = buildHeadArgs(hw({ hwaccel: "qsv", variant: "remote", startIndex: 0 }));
    expect(argValue(args, "-vf")).toBe("scale_qsv=w=-1:h=720");
  });

  it("qsv interlaced: vpp_qsv=deinterlace=2", () => {
    const args = buildHeadArgs(hw({ hwaccel: "qsv", variant: "original", startIndex: 0, source: INTERLACED_SOURCE }));
    expect(argValue(args, "-vf")).toBe("vpp_qsv=deinterlace=2");
  });

  it("a 10-bit source decodes in software and uploads frames, keeping the device flag but dropping -hwaccel", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "original", startIndex: 0, source: TEN_BIT_SOURCE }));
    expect(args).not.toContain("-hwaccel");
    expect(args).not.toContain("-hwaccel_output_format");
    expect(args).toContain("-vaapi_device");
    expect(argValue(args, "-vf")).toBe("format=nv12,hwupload");
  });

  it("10-bit + interlaced + remote chains format/hwupload, deinterlace, then scale", () => {
    const args = buildHeadArgs(
      hw({ hwaccel: "vaapi", variant: "remote", startIndex: 0, source: { ...TEN_BIT_SOURCE, interlaced: true } }),
    );
    expect(argValue(args, "-vf")).toBe("format=nv12,hwupload,deinterlace_vaapi,scale_vaapi=w=-2:h=min(720\\,ih)");
  });

  it("qsv 10-bit keeps -qsv_device and drops -hwaccel the same way", () => {
    const args = buildHeadArgs(hw({ hwaccel: "qsv", variant: "original", startIndex: 0, source: TEN_BIT_SOURCE }));
    expect(args).not.toContain("-hwaccel");
    expect(args).toContain("-qsv_device");
  });

  it("uses a custom render device when given", () => {
    const args = buildHeadArgs(hw({ hwaccel: "vaapi", variant: "original", startIndex: 0, renderDevice: "/dev/dri/renderD129" }));
    expect(argValue(args, "-vaapi_device")).toBe("/dev/dri/renderD129");
  });

  it("throws when hardware GOP alignment is requested without a usable fps", () => {
    expect(() =>
      buildHeadArgs(hw({ hwaccel: "vaapi", variant: "original", startIndex: 0, source: { ...PROGRESSIVE_SOURCE, fps: null } })),
    ).toThrow(/fps/);
    expect(() =>
      buildHeadArgs(hw({ hwaccel: "qsv", variant: "original", startIndex: 0, source: { ...PROGRESSIVE_SOURCE, fps: 0 } })),
    ).toThrow(/fps/);
  });

  it("copy-tier video never gets hwaccel decode flags, even when hwaccel is set", () => {
    const args = buildHeadArgs(baseInput({ hwaccel: "vaapi", variant: "original", startIndex: 0 }));
    expect(args).not.toContain("-hwaccel");
    expect(args).not.toContain("-vaapi_device");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy"]));
  });
});

describe("buildHeadArgs -- audio", () => {
  it("copies compatible audio as-is", () => {
    const args = buildHeadArgs(baseInput({ audio: { streamIndex: 1, action: "copy", sourceChannels: 6 } }));
    expect(args).toEqual(expect.arrayContaining(["-c:a", "copy"]));
  });

  it("transcodes audio using the shared channel/bitrate helpers", () => {
    const args = buildHeadArgs(baseInput({ audio: { streamIndex: 1, action: "transcode", sourceChannels: 8 } }));
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ac", "6", "-b:a", "384k"]));
  });

  it("Remote always re-encodes to stereo AAC at REMOTE_AUDIO_BITRATE, even when the action is 'copy'", () => {
    const args = buildHeadArgs(baseInput({ variant: "remote", audio: { streamIndex: 1, action: "copy", sourceChannels: 6 } }));
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ac", "2", "-b:a", REMOTE_AUDIO_BITRATE]));
  });

  it("throws when action is 'none' but a stream index is given", () => {
    expect(() => buildHeadArgs(baseInput({ audio: { streamIndex: 1, action: "none", sourceChannels: null } }))).toThrow(
      /stream index/,
    );
  });

  it("throws when an action other than 'none' has no stream index", () => {
    expect(() => buildHeadArgs(baseInput({ audio: { streamIndex: null, action: "copy", sourceChannels: null } }))).toThrow(
      /stream index/,
    );
  });

  it("throws on a negative or non-integer audio stream index", () => {
    expect(() => buildHeadArgs(baseInput({ audio: { streamIndex: -1, action: "copy", sourceChannels: 2 } }))).toThrow(
      /audio stream index/,
    );
    expect(() => buildHeadArgs(baseInput({ audio: { streamIndex: 1.5, action: "copy", sourceChannels: 2 } }))).toThrow(
      /audio stream index/,
    );
  });
});

describe("buildHeadArgs -- validation", () => {
  it("throws on an empty segment table", () => {
    expect(() => buildHeadArgs(baseInput({ segments: [] }))).toThrow(/empty/);
  });

  it("throws when the segment table isn't a complete 0-based sequence", () => {
    expect(() => buildHeadArgs(baseInput({ segments: [{ index: 1, start: 0, duration: 2 }] }))).toThrow(
      /0-based sequence/,
    );
  });

  it("throws on an out-of-range startIndex", () => {
    expect(() => buildHeadArgs(baseInput({ startIndex: -1 }))).toThrow(/startIndex/);
    expect(() => buildHeadArgs(baseInput({ startIndex: 3 }))).toThrow(/startIndex/);
    expect(() => buildHeadArgs(baseInput({ startIndex: 1.5 }))).toThrow(/startIndex/);
    expect(() => buildHeadArgs(baseInput({ startIndex: Number.NaN }))).toThrow(/startIndex/);
  });

  it("throws on an empty input path or outDir", () => {
    expect(() => buildHeadArgs(baseInput({ input: "" }))).toThrow(/input path/);
    expect(() => buildHeadArgs(baseInput({ outDir: "" }))).toThrow(/outDir/);
  });
});

describe("buildHeadArgs -- -segment_time_delta per tier (VM finding, 19 Sep 2026)", () => {
  it("is tight for copied video and wide for every transcode", () => {
    const find = (args: string[]) => args[args.indexOf("-segment_time_delta") + 1];
    const all = [
      ...[true, false].flatMap((copy) =>
        (["none", "vaapi", "qsv"] as const).map((hwaccel) => ({ copy, hwaccel })),
      ),
    ];
    for (const { copy, hwaccel } of all) {
      const args = buildHeadArgs({
        input: "/movies/a.mkv",
        plan: planVideoPlayback({
          videoCodec: copy ? "h264" : "vc1",
          container: "mkv",
          audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6, title: null, isDefault: true, isDescriptive: false }],
        } as never)!,
        variant: "original",
        audio: { streamIndex: 1, action: "copy", sourceChannels: 6 },
        segments: [
          { index: 0, start: 0, duration: 6 },
          { index: 1, start: 6, duration: 6 },
        ],
        startIndex: 0,
        outDir: "/cache/k/.part-1",
        hwaccel,
        source: { fps: 24, pixFmt: "yuv420p", interlaced: false, width: 1920, height: 1080 },
        keyframes: [0, 6],
      });
      expect(find(args)).toBe(copy ? "0.02" : "0.5");
      if (!copy && hwaccel === "none") expect(args).toEqual(expect.arrayContaining(["-sc_threshold", "0"]));
    }
  });
});
