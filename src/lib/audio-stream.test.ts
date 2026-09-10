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

  it("prefers a small lossy AAC remux for alac/flac when preferLossyRemote is set", () => {
    expect(resolvePlaybackFormat("alac", { preferLossyRemote: true })).toEqual({ kind: "aac-remote" });
    expect(resolvePlaybackFormat("flac", { preferLossyRemote: true })).toEqual({ kind: "aac-remote" });
    // Already-lossy/already-small codecs don't get a further degraded
    // remote variant — there's nothing to save.
    expect(resolvePlaybackFormat("mp3", { preferLossyRemote: true })).toEqual({
      kind: "passthrough",
      contentType: "audio/mpeg",
    });
    expect(resolvePlaybackFormat("aac", { preferLossyRemote: true })).toEqual({
      kind: "passthrough",
      contentType: "audio/mp4",
    });
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
