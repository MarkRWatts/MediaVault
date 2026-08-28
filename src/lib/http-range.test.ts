import { describe, expect, it } from "vitest";
import { parseRange } from "./http-range";

describe("parseRange", () => {
  const size = 1000;

  it("returns null with no header", () => {
    expect(parseRange(null, size)).toBeNull();
  });

  it("parses a bounded range", () => {
    expect(parseRange("bytes=0-499", size)).toEqual({ start: 0, end: 499 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past the file size", () => {
    expect(parseRange("bytes=900-10000", size)).toEqual({ start: 900, end: 999 });
  });

  it("rejects a start past the file size", () => {
    expect(parseRange("bytes=1000-", size)).toBe("unsatisfiable");
  });

  it("rejects start > end", () => {
    expect(parseRange("bytes=500-100", size)).toBe("unsatisfiable");
  });

  it("rejects garbage", () => {
    expect(parseRange("kittens", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=-", size)).toBe("unsatisfiable");
  });
});
