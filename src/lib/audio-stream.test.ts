import { describe, expect, it } from "vitest";
import { resolvePlaybackFormat } from "./audio-stream";

describe("resolvePlaybackFormat", () => {
  it("passes mp3 through as audio/mpeg", () => {
    expect(resolvePlaybackFormat("mp3")).toEqual({ kind: "passthrough", contentType: "audio/mpeg" });
  });

  it("passes aac through as audio/mp4", () => {
    expect(resolvePlaybackFormat("aac")).toEqual({ kind: "passthrough", contentType: "audio/mp4" });
  });

  it("remuxes alac and flac to flac", () => {
    expect(resolvePlaybackFormat("alac")).toEqual({ kind: "flac" });
    expect(resolvePlaybackFormat("flac")).toEqual({ kind: "flac" });
  });

  it("is case-insensitive", () => {
    expect(resolvePlaybackFormat("MP3")).toEqual({ kind: "passthrough", contentType: "audio/mpeg" });
    expect(resolvePlaybackFormat("ALAC")).toEqual({ kind: "flac" });
  });

  it("rejects drm, unknown, and missing codecs", () => {
    expect(resolvePlaybackFormat("drm")).toBeNull();
    expect(resolvePlaybackFormat("unknown")).toBeNull();
    expect(resolvePlaybackFormat(null)).toBeNull();
    expect(resolvePlaybackFormat(undefined)).toBeNull();
  });
});
