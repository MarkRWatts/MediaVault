import { describe, expect, it } from "vitest";
import { PCM_HEADERS, PcmChunker, parseEstimatedBytes, parsePcmFormat } from "./pcm-chunks";

function s16(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => {
    out[i * 2] = s & 0xff;
    out[i * 2 + 1] = (s >> 8) & 0xff;
  });
  return out;
}

function s24(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 3);
  samples.forEach((s, i) => {
    out[i * 3] = s & 0xff;
    out[i * 3 + 1] = (s >> 8) & 0xff;
    out[i * 3 + 2] = (s >> 16) & 0xff;
  });
  return out;
}

describe("parsePcmFormat", () => {
  it("reads the three format headers", () => {
    const h = new Headers({ [PCM_HEADERS.sampleRate]: "48000", [PCM_HEADERS.channels]: "2", [PCM_HEADERS.bits]: "24" });
    expect(parsePcmFormat(h)).toEqual({ sampleRate: 48000, channels: 2, bits: 24 });
  });

  it("rejects missing or nonsensical headers", () => {
    expect(parsePcmFormat(new Headers())).toBeNull();
    expect(parsePcmFormat(new Headers({ [PCM_HEADERS.sampleRate]: "44100", [PCM_HEADERS.channels]: "2", [PCM_HEADERS.bits]: "8" }))).toBeNull();
    expect(parsePcmFormat(new Headers({ [PCM_HEADERS.sampleRate]: "0", [PCM_HEADERS.channels]: "2", [PCM_HEADERS.bits]: "16" }))).toBeNull();
  });

  it("estimated bytes is optional", () => {
    expect(parseEstimatedBytes(new Headers())).toBeNull();
    expect(parseEstimatedBytes(new Headers({ [PCM_HEADERS.estimatedBytes]: "1234" }))).toBe(1234);
  });
});

describe("PcmChunker", () => {
  const stereo16 = { sampleRate: 44100, channels: 2, bits: 16 as const };

  it("emits whole chunks of chunkFrames frames, de-interleaved and scaled to [-1, 1)", () => {
    const chunker = new PcmChunker(stereo16, 2);
    // Two frames: L=16384 R=-16384, L=32767 R=-32768.
    const chunks = chunker.push(s16(16384, -16384, 32767, -32768));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0][0])).toEqual([0.5, 32767 / 32768]);
    expect(Array.from(chunks[0][1])).toEqual([-0.5, -1]);
  });

  it("carries a partial frame across pushes and never splits a frame", () => {
    const chunker = new PcmChunker(stereo16, 1);
    const bytes = s16(1000, -1000, 2000, -2000); // 2 frames = 8 bytes
    expect(chunker.push(bytes.subarray(0, 3))).toHaveLength(0); // mid-sample
    const chunks = chunker.push(bytes.subarray(3));
    expect(chunks).toHaveLength(2);
    expect(chunks[0][0][0]).toBeCloseTo(1000 / 32768, 6);
    expect(chunks[0][1][0]).toBeCloseTo(-1000 / 32768, 6);
    expect(chunks[1][0][0]).toBeCloseTo(2000 / 32768, 6);
    expect(chunks[1][1][0]).toBeCloseTo(-2000 / 32768, 6);
  });

  it("flush drains a trailing short chunk, and nothing after that", () => {
    const chunker = new PcmChunker(stereo16, 4);
    expect(chunker.push(s16(1, 2, 3, 4, 5, 6))).toHaveLength(0); // 3 frames < 4
    const tail = chunker.flush();
    expect(tail).not.toBeNull();
    expect(tail![0]).toHaveLength(3);
    expect(chunker.flush()).toBeNull();
  });

  it("decodes 24-bit samples including negative values", () => {
    const chunker = new PcmChunker({ sampleRate: 48000, channels: 1, bits: 24 }, 3);
    const chunks = chunker.push(s24(4194304, -4194304, -8388608));
    expect(Array.from(chunks[0][0])).toEqual([0.5, -0.5, -1]);
  });

  it("rejects a non-positive chunk size", () => {
    expect(() => new PcmChunker(stereo16, 0)).toThrow();
  });
});
