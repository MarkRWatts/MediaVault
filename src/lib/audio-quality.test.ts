import { describe, expect, it } from "vitest";
import { qualityLabel } from "./audio-quality";

describe("qualityLabel", () => {
  it("labels lossless tracks as bitDepth/sampleRate-in-kHz", () => {
    expect(
      qualityLabel({
        codec: "alac",
        lossless: true,
        sampleRate: 44100,
        bitDepth: 16,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBe("16/44.1");

    expect(
      qualityLabel({
        codec: "flac",
        lossless: true,
        sampleRate: 48000,
        bitDepth: 24,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBe("24/48");
  });

  it("drops trailing zeros from odd sample rates", () => {
    expect(
      qualityLabel({
        codec: "alac",
        lossless: true,
        sampleRate: 88200,
        bitDepth: 16,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBe("16/88.2");

    expect(
      qualityLabel({
        codec: "alac",
        lossless: true,
        sampleRate: 96000,
        bitDepth: 24,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBe("24/96");
  });

  it("returns null for lossless tracks missing bitDepth or sampleRate", () => {
    expect(
      qualityLabel({
        codec: "alac",
        lossless: true,
        sampleRate: null,
        bitDepth: 16,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBeNull();

    expect(
      qualityLabel({
        codec: "flac",
        lossless: true,
        sampleRate: 44100,
        bitDepth: null,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBeNull();
  });

  it("labels lossy tracks with an average kbps rounded to the nearest 16", () => {
    // ~320 kbps mp3, 4 minutes: sizeBytes*8/durationSecs/1000 ~= 320.99 -> rounds to 320.
    expect(
      qualityLabel({
        codec: "mp3",
        lossless: false,
        sampleRate: 44100,
        bitDepth: null,
        sizeBytes: 9_630_000,
        durationSecs: 240,
      }),
    ).toBe("~320k");

    // ~256 kbps aac.
    expect(
      qualityLabel({
        codec: "aac",
        lossless: false,
        sampleRate: 44100,
        bitDepth: null,
        sizeBytes: 7_680_000,
        durationSecs: 240,
      }),
    ).toBe("~256k");
  });

  it("rounds to the nearest 16 rather than truncating", () => {
    // Exactly 328 kbps average -> nearest multiple of 16 is 328? no, 328 is
    // not a multiple of 16; nearest multiples are 320 and 336. 328 is
    // equidistant-ish; pick a value clearly closer to 336.
    const sizeBytes = (330 * 1000 * 240) / 8; // avg kbps = 330 -> nearest 16 => 336
    expect(
      qualityLabel({
        codec: "mp3",
        lossless: false,
        sampleRate: 44100,
        bitDepth: null,
        sizeBytes,
        durationSecs: 240,
      }),
    ).toBe("~336k");
  });

  it("returns null for lossy tracks missing sizeBytes or durationSecs", () => {
    expect(
      qualityLabel({
        codec: "mp3",
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: null,
        durationSecs: 240,
      }),
    ).toBeNull();

    expect(
      qualityLabel({
        codec: "aac",
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: 7_680_000,
        durationSecs: null,
      }),
    ).toBeNull();

    expect(
      qualityLabel({
        codec: "aac",
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: 7_680_000,
        durationSecs: 0,
      }),
    ).toBeNull();
  });

  it("returns null for DRM tracks regardless of other fields", () => {
    expect(
      qualityLabel({
        codec: "drm",
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: 5_000_000,
        durationSecs: 200,
      }),
    ).toBeNull();
  });

  it("returns null for unknown/unrecognised codecs", () => {
    expect(
      qualityLabel({
        codec: null,
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: 5_000_000,
        durationSecs: 200,
      }),
    ).toBeNull();

    expect(
      qualityLabel({
        codec: "wma",
        lossless: false,
        sampleRate: null,
        bitDepth: null,
        sizeBytes: 5_000_000,
        durationSecs: 200,
      }),
    ).toBeNull();
  });

  it("returns null when lossless/lossy classification disagrees with the codec", () => {
    // codec is a lossy one but lossless flag says otherwise (shouldn't
    // happen in practice, but the helper should stay conservative).
    expect(
      qualityLabel({
        codec: "mp3",
        lossless: true,
        sampleRate: 44100,
        bitDepth: 16,
        sizeBytes: null,
        durationSecs: null,
      }),
    ).toBeNull();
  });
});
