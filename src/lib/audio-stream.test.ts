import { describe, expect, it } from "vitest";
import { estimatePcmBytes, resolvePcmFormat } from "./audio-stream";

const cd = { sampleRate: 44100, bitDepth: 16 };
const hiRes = { sampleRate: 48000, bitDepth: 24 };
const unprobed = { sampleRate: null, bitDepth: null };

describe("resolvePcmFormat", () => {
  it("decodes every playable codec to stereo PCM at the file's rate and depth", () => {
    for (const codec of ["mp3", "aac", "alac", "flac"]) {
      expect(resolvePcmFormat(codec, cd)).toEqual({ sampleRate: 44100, channels: 2, bits: 16 });
    }
    expect(resolvePcmFormat("alac", hiRes)).toEqual({ sampleRate: 48000, channels: 2, bits: 24 });
  });

  it("uses the client's requested rate when it's a real device rate, else the file's", () => {
    expect(resolvePcmFormat("alac", cd, 48000)?.sampleRate).toBe(48000);
    expect(resolvePcmFormat("alac", cd, 96000)?.sampleRate).toBe(96000);
    expect(resolvePcmFormat("alac", cd, 12345)?.sampleRate).toBe(44100);
    expect(resolvePcmFormat("alac", cd, null)?.sampleRate).toBe(44100);
  });

  it("falls back to 44.1 kHz / 16-bit for an unprobed track", () => {
    expect(resolvePcmFormat("mp3", unprobed)).toEqual({ sampleRate: 44100, channels: 2, bits: 16 });
  });

  it("is case-insensitive", () => {
    expect(resolvePcmFormat("ALAC", cd)).not.toBeNull();
  });

  it("rejects drm, unknown, and missing codecs", () => {
    expect(resolvePcmFormat("drm", cd)).toBeNull();
    expect(resolvePcmFormat("unknown", cd)).toBeNull();
    expect(resolvePcmFormat(null, cd)).toBeNull();
    expect(resolvePcmFormat(undefined, cd)).toBeNull();
  });
});

describe("estimatePcmBytes", () => {
  it("is duration × rate × channels × bytes-per-sample", () => {
    expect(estimatePcmBytes(10, { sampleRate: 44100, channels: 2, bits: 16 })).toBe(10 * 44100 * 2 * 2);
    expect(estimatePcmBytes(1.5, { sampleRate: 48000, channels: 2, bits: 24 })).toBe(72000 * 2 * 3);
  });

  it("is null without a usable duration", () => {
    expect(estimatePcmBytes(null, { sampleRate: 44100, channels: 2, bits: 16 })).toBeNull();
    expect(estimatePcmBytes(0, { sampleRate: 44100, channels: 2, bits: 16 })).toBeNull();
  });
});
