// Pure parsing/threshold logic, plus resolveInterlaced's decision tree with
// its dependencies (the DB cache, the ffmpeg-spawning measurement) mocked
// out. measureInterlace itself -- and the claim that it tells a real
// interlaced source from a progressive one flagged interlaced -- is only
// provable against real ffmpeg, so that lives in the gated integration test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERLACED_THRESHOLD,
  MIN_SAMPLED_FRAMES,
  isMeasuredInterlaced,
  parseIdetOutput,
  resolveInterlaced,
  type ResolveInterlacedInput,
} from "./interlace";
import * as store from "./interlace-store";

vi.mock("./interlace-store", () => ({
  loadInterlaceCheck: vi.fn(),
  saveInterlaceCheck: vi.fn(),
}));

const loadMock = vi.mocked(store.loadInterlaceCheck);
const saveMock = vi.mocked(store.saveInterlaceCheck);

beforeEach(() => {
  loadMock.mockReset();
  saveMock.mockReset();
  saveMock.mockResolvedValue(undefined);
});

// Captured verbatim (ffmpeg 9.0.2, Homebrew, 19 Sep 2026): running idet
// against a real *file* (rather than a raw lavfi source) instantiates the
// filter twice -- once for ffmpeg's own stream probe (zero frames, all-zero
// counts) and once for the real decode -- which is exactly why the parser
// must take the LAST line rather than the first.
const REAL_IDET_STDERR_TWO_PASSES = `
Input #0, mpegts, from 'interlaced_test.ts':
  Duration: 00:00:08.00, start: 1.440000, bitrate: 426 kb/s
  Stream #0:0[0x100]: Video: mpeg2video (4:2:2) ([2][0][0][0] / 0x0002), yuv422p(tv, top first), 320x240 [SAR 1:1 DAR 4:3], 25 fps, 25 tbr, 90k tbn, start 1.440000
[Parsed_idet_0 @ 0x7810c3c540] Repeated Fields: Neither:     0 Top:     0 Bottom:     0
[Parsed_idet_0 @ 0x7810c3c540] Single frame detection: TFF:     0 BFF:     0 Progressive:     0 Undetermined:     0
[Parsed_idet_0 @ 0x7810c3c540] Multi frame detection: TFF:     0 BFF:     0 Progressive:     0 Undetermined:     0
Stream mapping:
  Stream #0:0 -> #0:0 (mpeg2video (native) -> wrapped_avframe (native))
[Parsed_idet_0 @ 0x7810c3cc00] Repeated Fields: Neither:   200 Top:     0 Bottom:     0
[Parsed_idet_0 @ 0x7810c3cc00] Single frame detection: TFF:   196 BFF:     0 Progressive:     0 Undetermined:     4
[Parsed_idet_0 @ 0x7810c3cc00] Multi frame detection: TFF:   200 BFF:     0 Progressive:     0 Undetermined:     0
[out#0/null @ 0x7810c3c300] video:83KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
frame=  200 fps=0.0 q=-0.0 Lsize=N/A time=00:00:08.00 bitrate=N/A speed= 148x elapsed=0:00:00.05
`;

// Captured verbatim from a single-pass run (raw lavfi source, no file probe
// to trigger a second instantiation of the filter).
const REAL_IDET_STDERR_ONE_PASS = `
[Parsed_idet_0 @ 0x7715028c00] Repeated Fields: Neither:    75 Top:     0 Bottom:     0
[Parsed_idet_0 @ 0x7715028c00] Single frame detection: TFF:    38 BFF:    29 Progressive:     8 Undetermined:     0
[Parsed_idet_0 @ 0x7715028c00] Multi frame detection: TFF:    41 BFF:    26 Progressive:     8 Undetermined:     0
[out#0/null @ 0x7715028900] video:31KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
`;

describe("parseIdetOutput", () => {
  it("takes the LAST multi-frame summary, not the stream-probe's all-zero one", () => {
    expect(parseIdetOutput(REAL_IDET_STDERR_TWO_PASSES)).toEqual({ tff: 200, bff: 0, progressive: 0, undetermined: 0 });
  });

  it("reads a single-pass real capture", () => {
    expect(parseIdetOutput(REAL_IDET_STDERR_ONE_PASS)).toEqual({ tff: 41, bff: 26, progressive: 8, undetermined: 0 });
  });

  it("is robust to a different amount of padding between the fields", () => {
    const line = "[Parsed_idet_0 @ 0x1] Multi frame detection: TFF: 1 BFF: 2 Progressive: 3 Undetermined: 4";
    expect(parseIdetOutput(line)).toEqual({ tff: 1, bff: 2, progressive: 3, undetermined: 4 });
  });

  it("returns null when there is no summary line at all", () => {
    expect(parseIdetOutput("")).toBeNull();
    expect(parseIdetOutput("ffmpeg version 9.0.2\nsome unrelated error\n")).toBeNull();
  });
});

describe("isMeasuredInterlaced", () => {
  it("is progressive well under the threshold", () => {
    expect(isMeasuredInterlaced({ sampledFrames: 900, interlacedFrames: 0 })).toBe(false);
  });

  it("is interlaced well over the threshold -- the concert-video fixture's real ratio", () => {
    expect(isMeasuredInterlaced({ sampledFrames: 1500, interlacedFrames: 1252 })).toBe(true);
  });

  it("sits right at the threshold on the interlaced side", () => {
    expect(isMeasuredInterlaced({ sampledFrames: 100, interlacedFrames: 20 })).toBe(true);
    expect(isMeasuredInterlaced({ sampledFrames: 100, interlacedFrames: 19 })).toBe(false);
  });

  it("is false, not true, when too few frames were sampled to mean anything", () => {
    // A caller must not read this false as "measured progressive" -- see
    // resolveInterlaced, which checks sampledFrames itself before trusting a
    // ratio this thin.
    expect(isMeasuredInterlaced({ sampledFrames: MIN_SAMPLED_FRAMES - 1, interlacedFrames: MIN_SAMPLED_FRAMES - 1 })).toBe(false);
  });

  it(`INTERLACED_THRESHOLD is ${INTERLACED_THRESHOLD}`, () => {
    expect(INTERLACED_THRESHOLD).toBeGreaterThan(0);
    expect(INTERLACED_THRESHOLD).toBeLessThan(0.5);
  });
});

describe("resolveInterlaced", () => {
  const input = (over: Partial<ResolveInterlacedInput> = {}): ResolveInterlacedInput => ({
    kind: "film",
    fileId: 1,
    absPath: "/movies/a.mkv",
    mtimeMs: 1000,
    sizeBytes: 5_000_000,
    durationSecs: 3600,
    headerInterlaced: true,
    ...over,
  });

  it("trusts a progressive header outright -- no cache lookup, no measurement", async () => {
    const measure = vi.fn();
    expect(await resolveInterlaced(input({ headerInterlaced: false }), { measure })).toBe(false);
    expect(measure).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("uses a fresh cached measurement without running ffmpeg again", async () => {
    loadMock.mockResolvedValue({ sampledFrames: 900, interlacedFrames: 0 });
    const measure = vi.fn();
    expect(await resolveInterlaced(input(), { measure })).toBe(false);
    expect(measure).not.toHaveBeenCalled();
  });

  it("measures fresh when the cache has nothing, or the row is stale", async () => {
    // loadInterlaceCheck itself resolves null for both "never measured" and
    // "measured, but the file's mtime/size moved on" -- see
    // interlace-store.ts -- so resolveInterlaced treats them identically.
    loadMock.mockResolvedValue(null);
    const measure = vi.fn().mockResolvedValue({ sampledFrames: 900, interlacedFrames: 900 });
    expect(await resolveInterlaced(input(), { measure })).toBe(true);
    expect(measure).toHaveBeenCalledWith("/movies/a.mkv", 3600);
    expect(saveMock).toHaveBeenCalledWith("film", 1, { mtimeMs: 1000, sizeBytes: BigInt(5_000_000) }, { sampledFrames: 900, interlacedFrames: 900 });
  });

  it("falls back to the header (true) when the measurement throws", async () => {
    loadMock.mockResolvedValue(null);
    const measure = vi.fn().mockRejectedValue(new Error("share is unreachable"));
    expect(await resolveInterlaced(input(), { measure })).toBe(true);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("falls back to the header when nothing could be measured", async () => {
    loadMock.mockResolvedValue(null);
    const measure = vi.fn().mockResolvedValue(null);
    expect(await resolveInterlaced(input(), { measure })).toBe(true);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("falls back to the header, and does not cache, when too few frames were sampled", async () => {
    loadMock.mockResolvedValue(null);
    const measure = vi.fn().mockResolvedValue({ sampledFrames: MIN_SAMPLED_FRAMES - 1, interlacedFrames: 0 });
    expect(await resolveInterlaced(input(), { measure })).toBe(true);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("shares one in-flight measurement between concurrent callers for the same file", async () => {
    loadMock.mockResolvedValue(null);
    let settle!: (v: { sampledFrames: number; interlacedFrames: number }) => void;
    const pending = new Promise<{ sampledFrames: number; interlacedFrames: number }>((resolve) => {
      settle = resolve;
    });
    const measure = vi.fn().mockReturnValue(pending);

    const a = resolveInterlaced(input(), { measure });
    const b = resolveInterlaced(input(), { measure });
    settle({ sampledFrames: 900, interlacedFrames: 0 });

    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(measure).toHaveBeenCalledTimes(1);
    // The cache is written once too -- two callers must not race two upserts.
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("measures again for a later, unrelated call once the first has settled", async () => {
    loadMock.mockResolvedValue(null);
    const measure = vi.fn().mockResolvedValue({ sampledFrames: 900, interlacedFrames: 900 });
    await resolveInterlaced(input(), { measure });
    await resolveInterlaced(input(), { measure });
    // Not sharing across settled calls is fine -- the DB cache (mocked here
    // as loadMock, always null) is what would short-circuit the second call
    // in production; the in-flight map only exists to dedupe overlap.
    expect(measure).toHaveBeenCalledTimes(2);
  });
});
