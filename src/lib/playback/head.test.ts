// The one pure thing head.ts owns: reading a line of the segment muxer's
// completion stream. Everything else in that module is a process, and is
// exercised by engine.integration.test.ts against a real ffmpeg.
import { describe, expect, it } from "vitest";
import { parseSegmentListLine } from "./head";

describe("parseSegmentListLine", () => {
  it("reads the three CSV fields", () => {
    expect(parseSegmentListLine("seg_00042.ts,252.000000,258.000000")).toEqual({
      name: "seg_00042.ts",
      startSecs: 252,
      endSecs: 258,
    });
  });

  it("takes the basename, so a build that prints the whole output path is still read as a name", () => {
    // This name goes on to address a file inside the staging directory; a
    // path from ffmpeg is a path we would then have to trust.
    expect(parseSegmentListLine("/cache/film-1-original-a1/.part-x/seg_00003.ts,18,24")?.name).toBe("seg_00003.ts");
  });

  it("ignores blank lines and anything that isn't a segment name", () => {
    expect(parseSegmentListLine("")).toBeNull();
    expect(parseSegmentListLine("   ")).toBeNull();
    expect(parseSegmentListLine("index.m3u8,0,6")).toBeNull();
    expect(parseSegmentListLine("../../etc/passwd,0,6")).toBeNull();
    expect(parseSegmentListLine("seg_3.ts,0,6")).toBeNull();
  });

  it("ignores a line missing its times, or carrying unusable ones", () => {
    expect(parseSegmentListLine("seg_00000.ts")).toBeNull();
    expect(parseSegmentListLine("seg_00000.ts,0")).toBeNull();
    expect(parseSegmentListLine("seg_00000.ts,nan,6")).toBeNull();
  });

  it("tolerates the trailing whitespace a line-split can leave behind", () => {
    expect(parseSegmentListLine("seg_00001.ts,6.000000,12.000000\r")?.endSecs).toBe(12);
  });
});
