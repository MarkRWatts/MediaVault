import { afterEach, describe, expect, it, vi } from "vitest";
import { isFilePlayable, playbackAvailable, playbackEngine } from "./engine-flag";

const ORIGINAL_PLAYBACK_ENGINE = process.env.PLAYBACK_ENGINE;
const ORIGINAL_JELLYFIN_URL = process.env.JELLYFIN_URL;
const ORIGINAL_JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;

function setJellyfinConfigured(configured: boolean) {
  if (configured) {
    process.env.JELLYFIN_URL = "http://jellyfin.example";
    process.env.JELLYFIN_API_KEY = "key";
  } else {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
  }
}

afterEach(() => {
  if (ORIGINAL_PLAYBACK_ENGINE === undefined) delete process.env.PLAYBACK_ENGINE;
  else process.env.PLAYBACK_ENGINE = ORIGINAL_PLAYBACK_ENGINE;
  if (ORIGINAL_JELLYFIN_URL === undefined) delete process.env.JELLYFIN_URL;
  else process.env.JELLYFIN_URL = ORIGINAL_JELLYFIN_URL;
  if (ORIGINAL_JELLYFIN_API_KEY === undefined) delete process.env.JELLYFIN_API_KEY;
  else process.env.JELLYFIN_API_KEY = ORIGINAL_JELLYFIN_API_KEY;
});

describe("playbackEngine", () => {
  it("defaults to jellyfin when unset", () => {
    delete process.env.PLAYBACK_ENGINE;
    expect(playbackEngine()).toBe("jellyfin");
  });

  it("reads local", () => {
    process.env.PLAYBACK_ENGINE = "local";
    expect(playbackEngine()).toBe("local");
  });

  it("reads jellyfin explicitly", () => {
    process.env.PLAYBACK_ENGINE = "jellyfin";
    expect(playbackEngine()).toBe("jellyfin");
  });

  it("falls back to jellyfin with a one-time warning for anything else", () => {
    process.env.PLAYBACK_ENGINE = "bogus";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(playbackEngine()).toBe("jellyfin");
      expect(playbackEngine()).toBe("jellyfin");
      // Called on every unrecognised read the first time it happens in this
      // process, but never more than once overall -- not once per call.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("bogus");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("playbackAvailable", () => {
  it("local engine is always available", () => {
    process.env.PLAYBACK_ENGINE = "local";
    setJellyfinConfigured(false);
    expect(playbackAvailable()).toBe(true);
  });

  it("jellyfin engine depends on jellyfinConfigured", () => {
    process.env.PLAYBACK_ENGINE = "jellyfin";
    setJellyfinConfigured(false);
    expect(playbackAvailable()).toBe(false);
    setJellyfinConfigured(true);
    expect(playbackAvailable()).toBe(true);
  });
});

describe("isFilePlayable", () => {
  it("jellyfin engine: needs Jellyfin configured AND a jellyfinId (today's rule)", () => {
    process.env.PLAYBACK_ENGINE = "jellyfin";
    setJellyfinConfigured(true);
    expect(isFilePlayable({ jellyfinId: "abc", videoCodec: null })).toBe(true);
    expect(isFilePlayable({ jellyfinId: null, videoCodec: "h264" })).toBe(false);

    setJellyfinConfigured(false);
    expect(isFilePlayable({ jellyfinId: "abc", videoCodec: "h264" })).toBe(false);
  });

  it("local engine: only needs the file to have been probed, regardless of Jellyfin", () => {
    process.env.PLAYBACK_ENGINE = "local";
    setJellyfinConfigured(false);
    expect(isFilePlayable({ jellyfinId: null, videoCodec: "vc1" })).toBe(true);
    expect(isFilePlayable({ jellyfinId: null, videoCodec: null })).toBe(false);

    // jellyfinId is irrelevant once the local engine is active.
    setJellyfinConfigured(true);
    expect(isFilePlayable({ jellyfinId: null, videoCodec: "h264" })).toBe(true);
  });
});
