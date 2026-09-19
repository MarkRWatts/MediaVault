import { afterEach, describe, expect, it } from "vitest";
import { ffmpegPath, ffprobePath } from "./ffmpeg-bin";

const ORIGINAL_FFMPEG_PATH = process.env.FFMPEG_PATH;
const ORIGINAL_FFPROBE_PATH = process.env.FFPROBE_PATH;

afterEach(() => {
  if (ORIGINAL_FFMPEG_PATH === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = ORIGINAL_FFMPEG_PATH;
  if (ORIGINAL_FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH;
  else process.env.FFPROBE_PATH = ORIGINAL_FFPROBE_PATH;
});

describe("ffmpegPath", () => {
  it("defaults to the bare binary name (PATH lookup) when unset", () => {
    delete process.env.FFMPEG_PATH;
    expect(ffmpegPath()).toBe("ffmpeg");
  });

  it("uses FFMPEG_PATH when set, e.g. the pinned jellyfin-ffmpeg binary", () => {
    process.env.FFMPEG_PATH = "/usr/lib/jellyfin-ffmpeg/ffmpeg";
    expect(ffmpegPath()).toBe("/usr/lib/jellyfin-ffmpeg/ffmpeg");
  });

  it("falls back to the default for an empty string", () => {
    process.env.FFMPEG_PATH = "";
    expect(ffmpegPath()).toBe("ffmpeg");
  });
});

describe("ffprobePath", () => {
  it("defaults to the bare binary name (PATH lookup) when unset", () => {
    delete process.env.FFPROBE_PATH;
    expect(ffprobePath()).toBe("ffprobe");
  });

  it("uses FFPROBE_PATH when set, e.g. the pinned jellyfin-ffmpeg binary", () => {
    process.env.FFPROBE_PATH = "/usr/lib/jellyfin-ffmpeg/ffprobe";
    expect(ffprobePath()).toBe("/usr/lib/jellyfin-ffmpeg/ffprobe");
  });

  it("falls back to the default for an empty string", () => {
    process.env.FFPROBE_PATH = "";
    expect(ffprobePath()).toBe("ffprobe");
  });
});
