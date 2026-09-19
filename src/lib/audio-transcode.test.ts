import { describe, expect, it } from "vitest";
import { needsTranscode, parseAudioQuality, transcodeEvictions, transcodeFileName } from "@/lib/audio-transcode";

describe("parseAudioQuality", () => {
  it("defaults to the original and only knows aac besides", () => {
    expect(parseAudioQuality(null)).toBe("original");
    expect(parseAudioQuality("")).toBe("original");
    expect(parseAudioQuality("original")).toBe("original");
    expect(parseAudioQuality("aac")).toBe("aac");
    expect(parseAudioQuality("opus")).toBeNull();
  });
});

describe("needsTranscode", () => {
  it("converts lossless sources and never re-encodes lossy ones", () => {
    expect(needsTranscode("alac")).toBe(true);
    expect(needsTranscode("FLAC")).toBe(true);
    expect(needsTranscode("aac")).toBe(false);
    expect(needsTranscode("mp3")).toBe(false);
    expect(needsTranscode(null)).toBe(false);
  });
});

describe("transcodeFileName", () => {
  it("carries the source mtime, so a re-rip misses the cache", () => {
    expect(transcodeFileName(12, 1700000000123.7)).toBe("12-1700000000123-aac256.m4a");
    expect(transcodeFileName(12, 1700000000123)).not.toBe(transcodeFileName(12, 1700000999000));
  });
});

describe("transcodeEvictions", () => {
  const files = [
    { name: "a", bytes: 40, lastServedMs: 300 },
    { name: "b", bytes: 40, lastServedMs: 100 },
    { name: "c", bytes: 40, lastServedMs: 200 },
  ];
  it("removes nothing under the limit", () => {
    expect(transcodeEvictions(files, 120, "a")).toEqual([]);
  });
  it("removes the least recently served first, only as many as needed", () => {
    expect(transcodeEvictions(files, 100, "a")).toEqual(["b"]);
    expect(transcodeEvictions(files, 50, "a")).toEqual(["b", "c"]);
  });
  it("never removes the file just written", () => {
    expect(transcodeEvictions(files, 50, "b")).toEqual(["c", "a"]);
  });
});
