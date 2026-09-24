import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hevcCodecFromInit, splitSegment, topLevelBoxes } from "./fmp4";

// The init segment the engine made for Man of Steel's 4K file (ftyp + moov
// only: track setup, no pictures): Main 10, High tier, level 5.1.
const uhdInit = readFileSync(path.join(__dirname, "__fixtures__", "uhd-hdr10-init.mp4"));

describe("hevcCodecFromInit", () => {
  it("reads the exact RFC 6381 string from the hvcC", () => {
    expect(hevcCodecFromInit(uhdInit)).toBe("hvc1.2.4.H153.90");
  });

  it("is null without an HEVC track", () => {
    expect(hevcCodecFromInit(Buffer.from("not an mp4"))).toBeNull();
  });
});

describe("splitSegment", () => {
  it("refuses a file with no media", () => {
    expect(topLevelBoxes(uhdInit).map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(() => splitSegment(uhdInit)).toThrow("no moof");
  });

  it("refuses a truncated file", () => {
    expect(() => topLevelBoxes(uhdInit.subarray(0, uhdInit.length - 10))).toThrow();
  });
});
