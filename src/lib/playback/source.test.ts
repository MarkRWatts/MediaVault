// The pure parts of source.ts. resolveSource itself needs a database, a
// share and an ffprobe, and is covered by engine.integration.test.ts.
import { describe, expect, it } from "vitest";
import { LruCache, audioFrameGridFor, labelAudioTracks, probeCacheKey, sourceFactsFromProbe, transcodeReasonsFor } from "./source";
import type { ProbeResult, ProbedAudioTrack } from "@/lib/ffprobe";
import type { VideoPlaybackPlan } from "@/lib/video-playback";

const probeResult = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  colorTransfer: null,
  hasDolbyVision: false,
  videoFps: 24000 / 1001,
  videoPixFmt: "yuv420p",
  videoFieldOrder: "progressive",
  durationSecs: 7200,
  sizeBytes: 40_000_000_000,
  tagYear: null,
  audioTracks: [],
  ...over,
});

const plan = (over: Partial<VideoPlaybackPlan> = {}): VideoPlaybackPlan => ({
  tier: "prepare",
  videoAction: "copy",
  audioStreamIndex: 1,
  audioAction: "copy",
  hevcTag: false,
  outputVideoCodec: "h264",
  outputAudioCodec: "ac3",
  reason: "",
  ...over,
});

describe("sourceFactsFromProbe", () => {
  it("carries the frame rate, pixel format and the source's own dimensions", () => {
    const facts = sourceFactsFromProbe(probeResult());
    expect(facts.fps).toBeCloseTo(23.976, 3);
    expect(facts.pixFmt).toBe("yuv420p");
    expect(facts).toMatchObject({ width: 1920, height: 1080, interlaced: false });
  });

  it("calls a real field order interlaced", () => {
    for (const order of ["tt", "bb", "tb", "bt", "TT"]) {
      expect(sourceFactsFromProbe(probeResult({ videoFieldOrder: order })).interlaced).toBe(true);
    }
  });

  it("treats an absent or unknown field order as progressive", () => {
    // Deinterlacing progressive video softens the picture and forces an
    // encode; being wrong the other way merely looks like the source.
    expect(sourceFactsFromProbe(probeResult({ videoFieldOrder: null })).interlaced).toBe(false);
    expect(sourceFactsFromProbe(probeResult({ videoFieldOrder: "unknown" })).interlaced).toBe(false);
  });

  it("reports zero dimensions rather than guessing when the probe has none", () => {
    expect(sourceFactsFromProbe(probeResult({ width: null, height: null }))).toMatchObject({ width: 0, height: 0 });
  });
});

describe("labelAudioTracks", () => {
  it("keeps the stream index and builds the dropdown's one-line label", () => {
    const tracks: ProbedAudioTrack[] = [
      {
        streamIdx: 1,
        codec: "dts",
        profile: "DTS-HD MA",
        language: "eng",
        channels: 8,
        layout: "7.1",
        title: "Surround 7.1",
        isDefault: true,
        isDescriptive: false,
        sampleRate: 48000,
        bitDepth: 24,
      },
    ];
    const [labelled] = labelAudioTracks(tracks);
    expect(labelled.streamIdx).toBe(1);
    expect(labelled.label).toContain("English");
  });
});

describe("transcodeReasonsFor", () => {
  it("always names the container -- every v4 play is rewritten to MPEG-TS", () => {
    expect(transcodeReasonsFor(plan(), "original")).toEqual(["ContainerNotSupported"]);
  });

  it("names the video codec when the Original variant has to re-encode", () => {
    expect(transcodeReasonsFor(plan({ videoAction: "transcode" }), "original")).toContain("VideoCodecNotSupported");
  });

  it("names the audio codec when the chosen track is transcoded", () => {
    expect(transcodeReasonsFor(plan({ audioAction: "transcode" }), "original")).toContain("AudioCodecNotSupported");
  });

  it("puts the Remote variant's re-encode down to bitrate, whatever the source codec is", () => {
    const reasons = transcodeReasonsFor(plan(), "remote");
    expect(reasons).toContain("VideoBitrateNotSupported");
    expect(reasons).toContain("AudioCodecNotSupported");
    expect(reasons).not.toContain("VideoCodecNotSupported");
  });
});

describe("probeCacheKey", () => {
  it("changes when the file changes, so a re-encoded file can never hit a stale probe", () => {
    const base = probeCacheKey("/m/a.mkv", 1000, 50);
    expect(probeCacheKey("/m/a.mkv", 1000, 50)).toBe(base);
    expect(probeCacheKey("/m/a.mkv", 1001, 50)).not.toBe(base);
    expect(probeCacheKey("/m/a.mkv", 1000, 51)).not.toBe(base);
    expect(probeCacheKey("/m/b.mkv", 1000, 50)).not.toBe(base);
  });
});

describe("LruCache", () => {
  it("returns what it was given, and undefined for anything else", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("evicts the least recently used once it is over its size", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("counts a read as a use, so the thing being watched isn't the thing evicted", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("overwrites in place without growing", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });
});

describe("audioFrameGridFor", () => {
  const aac = { codec: "aac", profile: "LC", sampleRate: 48000, startTime: -0.044 };

  it("anchors a copied AAC-LC track's 1024-sample grid at its first timestamp", () => {
    expect(audioFrameGridFor(aac, "copy")).toEqual({ sampleRate: 48000, startSamples: -2112, frameSamples: 1024 });
  });

  it("returns null for transcodes, other codecs, HE-AAC and unknown timing", () => {
    expect(audioFrameGridFor(aac, "transcode")).toBeNull();
    expect(audioFrameGridFor(null, "copy")).toBeNull();
    expect(audioFrameGridFor({ ...aac, codec: "eac3" }, "copy")).toBeNull();
    expect(audioFrameGridFor({ ...aac, profile: "HE-AAC" }, "copy")).toBeNull();
    expect(audioFrameGridFor({ ...aac, sampleRate: null }, "copy")).toBeNull();
    expect(audioFrameGridFor({ ...aac, startTime: null }, "copy")).toBeNull();
  });
});
