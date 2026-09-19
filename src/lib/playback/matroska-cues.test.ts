// Real Matroska fixtures under __fixtures__/ (generated with ffmpeg — see
// that directory's README for the exact commands) with a ground-truth JSON
// file per fixture produced by the same `ffprobe -show_entries
// packet=pts_time,flags` command keyframes.ts's fallback uses, so these
// tests need no ffmpeg/ffprobe at run time.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMatroskaCues } from "./matroska-cues";

const FIXTURES_DIR = path.join(import.meta.dirname, "__fixtures__");

interface GroundTruth {
  durationSecs: number;
  keyframeSecs: number[];
}

function loadGroundTruth(name: string): GroundTruth {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.ground-truth.json`), "utf8"));
}

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, `${name}.mkv`);
}

/** Every cue time must be one of ffprobe's real keyframe times, within 1ms —
 *  a Cues list is a *subset* of a file's keyframes by the format's own
 *  rules (see matroska-cues.ts's top comment), and these particular
 *  fixtures were muxed by ffmpeg, which cues every video keyframe, so in
 *  practice the two sets are equal. */
function expectCuesAreKeyframeSubset(cueSecs: number[], groundTruth: GroundTruth) {
  for (const cue of cueSecs) {
    const closest = groundTruth.keyframeSecs.reduce((best, k) => (Math.abs(k - cue) < Math.abs(best - cue) ? k : best));
    expect(Math.abs(closest - cue)).toBeLessThan(0.001);
  }
}

describe("readMatroskaCues", () => {
  it("reads Cues written after the Clusters (the ordinary MakeMKV/mkvmerge case), via SeekHead", async () => {
    const groundTruth = loadGroundTruth("normal");
    const result = await readMatroskaCues(fixturePath("normal"));
    expect(result.keyframeSecs).not.toBeNull();
    expectCuesAreKeyframeSubset(result.keyframeSecs!, groundTruth);
    expect(result.keyframeSecs).toEqual(groundTruth.keyframeSecs);
  });

  it("returns keyframes sorted and de-duplicated", async () => {
    const result = await readMatroskaCues(fixturePath("normal"));
    const secs = result.keyframeSecs!;
    const sorted = [...secs].sort((a, b) => a - b);
    expect(secs).toEqual(sorted);
    expect(new Set(secs).size).toBe(secs.length);
  });

  it("only reads a small fraction of the file (positional reads, never the whole thing)", async () => {
    const { statSync } = await import("node:fs");
    const size = statSync(fixturePath("normal")).size;
    const result = await readMatroskaCues(fixturePath("normal"));
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(result.bytesRead).toBeLessThan(size / 4);
  });

  it("reads Cues placed before the Clusters (-reserve_index_space)", async () => {
    const groundTruth = loadGroundTruth("cues-front");
    const result = await readMatroskaCues(fixturePath("cues-front"));
    expect(result.keyframeSecs).not.toBeNull();
    expectCuesAreKeyframeSubset(result.keyframeSecs!, groundTruth);
    expect(result.keyframeSecs).toEqual(groundTruth.keyframeSecs);
  });

  it("returns null for a file with no Cues (-live 1: unknown-size Segment/Clusters)", async () => {
    const result = await readMatroskaCues(fixturePath("no-cues"));
    expect(result.keyframeSecs).toBeNull();
  });

  it("on a larger file, bytesRead stays well under the file size", async () => {
    const { statSync } = await import("node:fs");
    const size = statSync(fixturePath("large")).size;
    const groundTruth = loadGroundTruth("large");
    const result = await readMatroskaCues(fixturePath("large"));
    expect(result.keyframeSecs).not.toBeNull();
    expectCuesAreKeyframeSubset(result.keyframeSecs!, groundTruth);
    expect(result.keyframeSecs).toEqual(groundTruth.keyframeSecs);
    // ~2.6MB file; the reader should need well under a tenth of it.
    expect(result.bytesRead).toBeLessThan(size / 10);
    expect(size).toBeGreaterThan(1024 * 1024);
  });
});
