import { describe, expect, it } from "vitest";
import { COVER_SIZES, parseCoverSize, resizeArgs, resizedCoverPath, scaleFilter } from "./cover-size";

describe("parseCoverSize", () => {
  it("accepts every allowed size", () => {
    for (const size of COVER_SIZES) {
      expect(parseCoverSize(String(size))).toBe(size);
    }
  });

  it("treats absent as 'as stored'", () => {
    expect(parseCoverSize(null)).toBeNull();
    expect(parseCoverSize(undefined)).toBeNull();
    expect(parseCoverSize("")).toBeNull();
  });

  it("refuses anything not on the allowlist", () => {
    // An open parameter would be an unbounded derivative directory.
    expect(parseCoverSize("500")).toBeNull();
    expect(parseCoverSize("2048")).toBeNull();
    expect(parseCoverSize("0")).toBeNull();
    expect(parseCoverSize("-256")).toBeNull();
  });

  it("refuses values that aren't plain numbers", () => {
    expect(parseCoverSize("512px")).toBeNull();
    expect(parseCoverSize("abc")).toBeNull();
    expect(parseCoverSize("512; rm -rf /")).toBeNull();
    // Number("") is 0 and Number(" 512 ") is 512 — the first is excluded
    // above, and the second is harmless, but neither may become a path.
    expect(parseCoverSize("../../etc/passwd")).toBeNull();
  });
});

describe("resizedCoverPath", () => {
  it("keeps the original's stem and names the size", () => {
    expect(resizedCoverPath("42.jpg", 256)).toBe("resized/42-256.jpg");
    expect(resizedCoverPath("1-cd.jpg", 512)).toBe("resized/1-cd-512.jpg");
  });

  it("gives each size its own file", () => {
    expect(resizedCoverPath("42.jpg", 128)).not.toBe(resizedCoverPath("42.jpg", 256));
  });

  it("never nests, whatever the stored path looks like", () => {
    expect(resizedCoverPath("sub/42.jpg", 128)).toBe("resized/sub-42-128.jpg");
  });
});

describe("scaleFilter", () => {
  it("caps the box at the source, so a small cover is never enlarged", () => {
    expect(scaleFilter(512)).toBe(
      "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease",
    );
  });
});

describe("resizeArgs", () => {
  it("states the output format, because the temporary's name can't imply it", () => {
    // Without these, ffmpeg fails on a `.tmp` output and the route
    // silently serves the full-size cover instead — which is how this
    // shipped broken the first time.
    const args = resizeArgs("/covers/42.jpg", 256, "/covers/resized/42-256.jpg.pid.tmp");
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe("image2");
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("mjpeg");
  });

  it("reads the source and writes the destination last", () => {
    const args = resizeArgs("/covers/42.jpg", 512, "/out.tmp");
    expect(args[args.indexOf("-i") + 1]).toBe("/covers/42.jpg");
    expect(args[args.length - 1]).toBe("/out.tmp");
  });

  it("carries the scale filter for the size asked for", () => {
    const args = resizeArgs("/covers/42.jpg", 128, "/out.tmp");
    expect(args[args.indexOf("-vf") + 1]).toBe(scaleFilter(128));
  });

  it("takes one frame, so an animated source can't write a sequence", () => {
    const args = resizeArgs("/covers/42.gif", 128, "/out.tmp");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
  });
});
