import { describe, expect, it } from "vitest";
import { hevcCodecString, hlsCodecs, renderMainPlaylist, renderMasterPlaylist, videoRangeFor } from "./playlist";
import type { SegmentEntry } from "./types";

describe("hlsCodecs", () => {
  it("returns just the video codec string when there's no audio", () => {
    expect(hlsCodecs("h264", null)).toBe("avc1.640028");
  });

  it("joins video and audio RFC 6381 strings", () => {
    expect(hlsCodecs("h264", "aac")).toBe("avc1.640028,mp4a.40.2");
    expect(hlsCodecs("h264", "ac3")).toBe("avc1.640028,ac-3");
    expect(hlsCodecs("h264", "eac3")).toBe("avc1.640028,ec-3");
    expect(hlsCodecs("hevc", "aac")).toBe("hvc1.1.6.L120.B0,mp4a.40.2");
  });

  it("throws for a codec with no known RFC 6381 string", () => {
    expect(() => hlsCodecs("av1", null)).toThrow(/video codec/);
    expect(() => hlsCodecs("h264", "opus")).toThrow(/audio codec/);
  });
});

describe("renderMasterPlaylist", () => {
  it("renders the required tags and a STREAM-INF with BANDWIDTH and CODECS", () => {
    const out = renderMasterPlaylist({ bandwidth: 5_000_000, codecs: "avc1.640028,mp4a.40.2", mainUri: "main.m3u8" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:3");
    expect(lines[2]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2"');
    expect(lines[3]).toBe("main.m3u8");
  });

  it("includes RESOLUTION when given", () => {
    const out = renderMasterPlaylist({
      bandwidth: 3_000_000,
      resolution: { width: 1280, height: 720 },
      codecs: "avc1.640028,mp4a.40.2",
      mainUri: "main.m3u8",
    });
    expect(out).toContain("RESOLUTION=1280x720");
    // Order matters for readability but not correctness -- just check both
    // attributes are present and BANDWIDTH comes first, matching Apple's
    // own examples.
    const streamInf = out.split("\n")[2];
    expect(streamInf.indexOf("BANDWIDTH")).toBeLessThan(streamInf.indexOf("RESOLUTION"));
    expect(streamInf.indexOf("RESOLUTION")).toBeLessThan(streamInf.indexOf("CODECS"));
  });

  it("rounds a fractional bandwidth to an integer", () => {
    const out = renderMasterPlaylist({ bandwidth: 1234.9, codecs: "avc1.640028", mainUri: "main.m3u8" });
    expect(out).toContain("BANDWIDTH=1235");
  });

  it("rejects a non-positive bandwidth", () => {
    expect(() => renderMasterPlaylist({ bandwidth: 0, codecs: "avc1.640028", mainUri: "main.m3u8" })).toThrow(
      /bandwidth/,
    );
    expect(() => renderMasterPlaylist({ bandwidth: -1, codecs: "avc1.640028", mainUri: "main.m3u8" })).toThrow(
      /bandwidth/,
    );
  });

  it("rejects a non-integer or non-positive resolution", () => {
    expect(() =>
      renderMasterPlaylist({
        bandwidth: 1,
        resolution: { width: 1280.5, height: 720 },
        codecs: "avc1.640028",
        mainUri: "main.m3u8",
      }),
    ).toThrow(/resolution/);
    expect(() =>
      renderMasterPlaylist({
        bandwidth: 1,
        resolution: { width: 0, height: 720 },
        codecs: "avc1.640028",
        mainUri: "main.m3u8",
      }),
    ).toThrow(/resolution/);
  });
});

describe("renderMainPlaylist", () => {
  const segments: SegmentEntry[] = [
    { index: 0, start: 0, duration: 6 },
    { index: 1, start: 6, duration: 6 },
    { index: 2, start: 12, duration: 3.5 },
  ];

  it("renders the fixed VOD header tags in order", () => {
    const out = renderMainPlaylist(segments);
    const lines = out.split("\n");
    expect(lines.slice(0, 6)).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
    ]);
    expect(lines[lines.length - 2]).toBe("#EXT-X-ENDLIST");
    // Trailing newline -> a final empty string after split.
    expect(lines[lines.length - 1]).toBe("");
  });

  it("emits one EXTINF (6 decimals) + filename pair per segment, in order", () => {
    const out = renderMainPlaylist(segments);
    const body = out.split("\n").slice(6, -2);
    expect(body).toEqual([
      "#EXTINF:6.000000,",
      "seg_00000.ts",
      "#EXTINF:6.000000,",
      "seg_00001.ts",
      "#EXTINF:3.500000,",
      "seg_00002.ts",
    ]);
  });

  it("sets TARGETDURATION to the ceiling of the longest segment, not the longest itself", () => {
    const out = renderMainPlaylist([{ index: 0, start: 0, duration: 5.2 }]);
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
  });

  it("TARGETDURATION is still correct when the longest duration is already an integer", () => {
    const out = renderMainPlaylist([{ index: 0, start: 0, duration: 6 }]);
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
  });

  it("handles a single-segment table", () => {
    const out = renderMainPlaylist([{ index: 0, start: 0, duration: 1.234567 }]);
    expect(out).toContain("#EXTINF:1.234567,");
    expect(out).toContain("seg_00000.ts");
    expect(out).toContain("#EXT-X-ENDLIST");
  });

  it("rejects an empty segment table", () => {
    expect(() => renderMainPlaylist([])).toThrow(/no segments/);
  });

  it("rejects a table that isn't a complete 0-based sequence", () => {
    expect(() => renderMainPlaylist([{ index: 1, start: 0, duration: 6 }])).toThrow(/0-based sequence/);
    expect(() =>
      renderMainPlaylist([
        { index: 0, start: 0, duration: 6 },
        { index: 2, start: 6, duration: 6 },
      ]),
    ).toThrow(/0-based sequence/);
  });

  it("rejects a non-positive or non-finite duration", () => {
    expect(() => renderMainPlaylist([{ index: 0, start: 0, duration: 0 }])).toThrow(/duration/);
    expect(() => renderMainPlaylist([{ index: 0, start: 0, duration: -1 }])).toThrow(/duration/);
    expect(() => renderMainPlaylist([{ index: 0, start: 0, duration: Number.NaN }])).toThrow(/duration/);
  });
});

describe("copied HEVC in the master playlist", () => {
  it("names Main 10 and level 5.1 for a 10-bit Ultra HD source", () => {
    expect(hevcCodecString({ pixFmt: "yuv420p10le", height: 2160 })).toBe("hvc1.2.4.L153.B0");
    expect(hevcCodecString({ pixFmt: "yuv420p", height: 1080 })).toBe("hvc1.1.6.L123.B0");
    expect(hevcCodecString({ pixFmt: null, height: 0 })).toBe("hvc1.1.6.L123.B0");
  });

  it("marks HDR for the display, and leaves SDR unsaid", () => {
    expect(videoRangeFor("smpte2084")).toBe("PQ");
    expect(videoRangeFor("arib-std-b67")).toBe("HLG");
    expect(videoRangeFor("bt709")).toBeUndefined();
    expect(videoRangeFor(null)).toBeUndefined();
    expect(
      renderMasterPlaylist({
        bandwidth: 54_000_000,
        resolution: { width: 3840, height: 2160 },
        codecs: "hvc1.2.4.L153.B0,mp4a.40.2",
        videoRange: "PQ",
        mainUri: "main.m3u8",
      }),
    ).toContain('#EXT-X-STREAM-INF:BANDWIDTH=54000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,mp4a.40.2",VIDEO-RANGE=PQ\n');
  });
});
