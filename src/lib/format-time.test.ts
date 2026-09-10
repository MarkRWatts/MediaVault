import { describe, expect, it } from "vitest";
import { formatLoadProgress } from "./format-time";

describe("formatLoadProgress", () => {
  it("returns null when nothing is loading", () => {
    expect(formatLoadProgress(null)).toBeNull();
  });

  it("shows a percentage once total is known", () => {
    expect(formatLoadProgress({ loaded: 1_000_000, total: 4_000_000 })).toBe("Downloading 25%");
    expect(formatLoadProgress({ loaded: 4_000_000, total: 4_000_000 })).toBe("Downloading 100%");
  });

  it("clamps an over-length read (a chunk landing past a mis-reported total) to 100%", () => {
    expect(formatLoadProgress({ loaded: 5_000_000, total: 4_000_000 })).toBe("Downloading 100%");
  });

  it("falls back to a running byte count when total is unknown (the common ffmpeg-remux case)", () => {
    expect(formatLoadProgress({ loaded: 2.5 * 1024 * 1024, total: null })).toBe("Downloading 2.5 MB");
  });

  it("shows an ellipsis rather than 0.0 MB right at the start of a download", () => {
    expect(formatLoadProgress({ loaded: 512, total: null })).toBe("Downloading …");
  });

  it("treats a zero or missing total the same as unknown, not a 0-length file", () => {
    expect(formatLoadProgress({ loaded: 1024, total: 0 })).toBe("Downloading …");
  });
});
