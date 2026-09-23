// Real MP4 fixtures under __fixtures__/ (mp4-*.mp4, generated with ffmpeg --
// see that directory's README for the exact commands) with a ground-truth
// JSON file per fixture produced by the same `ffprobe -show_entries
// packet=pts_time,flags` command keyframes.ts's fallback uses, so these
// tests need no ffmpeg/ffprobe at run time.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMp4SyncSamples } from "./mp4-sync-samples";

const FIXTURES_DIR = path.join(import.meta.dirname, "__fixtures__");

interface GroundTruth {
  durationSecs: number;
  keyframeSecs: number[];
}

function loadGroundTruth(name: string): GroundTruth {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.ground-truth.json`), "utf8"));
}

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, `${name}.mp4`);
}

/** MP4 times are exact fractions of the track timescale; ffprobe prints them
 *  rounded to six decimal places. Within 2µs is "the same keyframe". */
function expectSameKeyframes(actual: number[] | null, expected: number[]) {
  expect(actual).not.toBeNull();
  expect(actual!.length).toBe(expected.length);
  actual!.forEach((secs, i) => expect(Math.abs(secs - expected[i])).toBeLessThan(2e-6));
}

describe("readMp4SyncSamples", () => {
  it("reads a faststart file with B-frames (ctts and an edit list), matching ffprobe", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-normal"));
    expectSameKeyframes(result.keyframeSecs, loadGroundTruth("mp4-normal").keyframeSecs);
  });

  it("finds moov after mdat, skipping mdat by its header", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-moov-end"));
    expectSameKeyframes(result.keyframeSecs, loadGroundTruth("mp4-moov-end").keyframeSecs);
  });

  it("applies a leading empty edit (a video track that starts late)", async () => {
    const groundTruth = loadGroundTruth("mp4-delayed");
    expect(groundTruth.keyframeSecs[0]).toBeGreaterThan(1.5); // the fixture really is delayed
    const result = await readMp4SyncSamples(fixturePath("mp4-delayed"));
    expectSameKeyframes(result.keyframeSecs, groundTruth.keyframeSecs);
  });

  it("reads negative composition offsets (version-1 ctts)", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-negative-cts"));
    expectSameKeyframes(result.keyframeSecs, loadGroundTruth("mp4-negative-cts").keyframeSecs);
  });

  it("treats every sample as a keyframe when the track has no stss", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-all-intra"));
    expectSameKeyframes(result.keyframeSecs, loadGroundTruth("mp4-all-intra").keyframeSecs);
  });

  it("reads H.264 stream-copied out of Matroska (variable stts deltas) -- how the library was converted", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-copied"));
    expectSameKeyframes(result.keyframeSecs, loadGroundTruth("mp4-copied").keyframeSecs);
  });

  it("returns null for a fragmented file, leaving it to the ffprobe fallback", async () => {
    const result = await readMp4SyncSamples(fixturePath("mp4-fragmented"));
    expect(result.keyframeSecs).toBeNull();
  });

  it("returns keyframes sorted and de-duplicated", async () => {
    const secs = (await readMp4SyncSamples(fixturePath("mp4-normal"))).keyframeSecs!;
    expect(secs).toEqual([...secs].sort((a, b) => a - b));
    expect(new Set(secs).size).toBe(secs.length);
  });

  it("only reads a small fraction of the file -- never mdat", async () => {
    for (const name of ["mp4-normal", "mp4-moov-end"]) {
      const size = statSync(fixturePath(name)).size;
      const result = await readMp4SyncSamples(fixturePath(name));
      expect(result.bytesRead).toBeGreaterThan(0);
      expect(result.bytesRead).toBeLessThan(size / 4);
    }
  });

  it("returns null for a file that isn't an MP4 at all", async () => {
    const result = await readMp4SyncSamples(path.join(FIXTURES_DIR, "normal.mkv"));
    expect(result.keyframeSecs).toBeNull();
  });
});
