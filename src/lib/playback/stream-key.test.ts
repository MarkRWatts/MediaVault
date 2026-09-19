import { describe, expect, it } from "vitest";
import {
  buildStreamKey,
  parseSegmentFileName,
  parseStreamKey,
  SEGMENT_FILE_RE,
  segmentFileName,
  STREAM_KEY_RE,
} from "./stream-key";
import type { StreamKeyParts } from "./types";

describe("buildStreamKey / parseStreamKey", () => {
  it("round-trips a film with a specific audio stream", () => {
    const parts: StreamKeyParts = { kind: "film", id: 42, variant: "original", audioStreamIndex: 1 };
    const key = buildStreamKey(parts);
    expect(key).toBe("film-42-original-a1");
    expect(parseStreamKey(key)).toEqual(parts);
  });

  it("round-trips a video-only file as 'adefault'", () => {
    const parts: StreamKeyParts = { kind: "episode", id: 7, variant: "remote", audioStreamIndex: null };
    const key = buildStreamKey(parts);
    expect(key).toBe("episode-7-remote-adefault");
    expect(parseStreamKey(key)).toEqual(parts);
  });

  it("supports every kind", () => {
    for (const kind of ["film", "scene", "episode"] as const) {
      const key = buildStreamKey({ kind, id: 1, variant: "original", audioStreamIndex: 0 });
      expect(key.startsWith(`${kind}-`)).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      buildStreamKey({ kind: "show" as never, id: 1, variant: "original", audioStreamIndex: null }),
    ).toThrow(/kind/);
  });

  it("rejects a non-positive or non-integer id", () => {
    expect(() => buildStreamKey({ kind: "film", id: 0, variant: "original", audioStreamIndex: null })).toThrow(/id/);
    expect(() => buildStreamKey({ kind: "film", id: -1, variant: "original", audioStreamIndex: null })).toThrow(/id/);
    expect(() => buildStreamKey({ kind: "film", id: 1.5, variant: "original", audioStreamIndex: null })).toThrow(/id/);
  });

  it("rejects an invalid variant", () => {
    expect(() => buildStreamKey({ kind: "film", id: 1, variant: "hd" as never, audioStreamIndex: null })).toThrow(
      /variant/,
    );
  });

  it("rejects a negative or non-integer audio stream index", () => {
    expect(() => buildStreamKey({ kind: "film", id: 1, variant: "original", audioStreamIndex: -1 })).toThrow(/audio/);
    expect(() => buildStreamKey({ kind: "film", id: 1, variant: "original", audioStreamIndex: 1.2 })).toThrow(
      /audio/,
    );
  });

  it("parses back only exact, well-formed keys", () => {
    expect(parseStreamKey("film-1-original-a0")).toEqual({
      kind: "film",
      id: 1,
      variant: "original",
      audioStreamIndex: 0,
    });
    expect(parseStreamKey("not-a-key")).toBeNull();
    expect(parseStreamKey("")).toBeNull();
  });

  // Path/URL safety: nothing beyond the closed enums and digits should ever
  // be accepted, since this string becomes a directory name and a URL path
  // segment (V4_PLAN.md, "Housekeeping").
  it("rejects path traversal, extra segments, and injected characters", () => {
    const bad = [
      "../../etc/passwd",
      "film-1-original-a0/../../etc",
      "film-1-original-a0/",
      "film-01-original-a0", // leading zero on id
      "film--1-original-a0",
      "film-1-original-a0-extra",
      "film-1-original-a-1",
      "film-1-original-a0\n",
      "FILM-1-original-a0",
      "film-1-Original-a0",
      "film-1-original-adefault ",
      "film_1_original_a0",
    ];
    for (const raw of bad) expect(parseStreamKey(raw)).toBeNull();
  });

  it("built keys always satisfy STREAM_KEY_RE", () => {
    for (const kind of ["film", "scene", "episode"] as const) {
      for (const variant of ["original", "remote"] as const) {
        for (const audioStreamIndex of [null, 0, 3]) {
          const key = buildStreamKey({ kind, id: 5, variant, audioStreamIndex });
          expect(STREAM_KEY_RE.test(key)).toBe(true);
        }
      }
    }
  });
});

describe("segmentFileName / parseSegmentFileName", () => {
  it("zero-pads to five digits", () => {
    expect(segmentFileName(0)).toBe("seg_00000.ts");
    expect(segmentFileName(42)).toBe("seg_00042.ts");
    expect(segmentFileName(99999)).toBe("seg_99999.ts");
  });

  it("round-trips through parseSegmentFileName", () => {
    for (const n of [0, 1, 42, 12345, 99999]) {
      expect(parseSegmentFileName(segmentFileName(n))).toBe(n);
    }
  });

  it("rejects an out-of-range or non-integer index", () => {
    expect(() => segmentFileName(-1)).toThrow(/range/);
    expect(() => segmentFileName(100000)).toThrow(/range/);
    expect(() => segmentFileName(1.5)).toThrow(/range/);
  });

  it("rejects anything not matching the exact pattern", () => {
    for (const name of ["seg_0000.ts", "seg_000000.ts", "seg_00001.mp4", "seg_00001.ts.bak", "../seg_00001.ts", ""]) {
      expect(parseSegmentFileName(name)).toBeNull();
      expect(SEGMENT_FILE_RE.test(name)).toBe(false);
    }
    expect(SEGMENT_FILE_RE.test("seg_00001.ts")).toBe(true);
  });
});
