// Unit coverage for engine-routes.ts's pure logic: the strict path grammar
// the local-engine catch-all accepts, the ownership check that keeps one
// route family/device from reaching another's stream key or session, the
// playlist rewrite that stamps every segment URI with the session query,
// and the PlaybackError -> HTTP mapping. The three handlers that build on
// these (engineSession/engineStop/engineProxy) are exercised end to end,
// against a real ffmpeg and a real temp database, by the route integration
// test alongside the /jf/* route files.
import { describe, expect, it, vi } from "vitest";
import { PlaybackError, type PlaybackErrorCode } from "./source";

const sessionBelongsTo = vi.fn();
// Everything else engine-routes.ts imports from "./engine" is only ever
// called from the three handlers under test elsewhere -- checkEngineAccess
// is the one pure export here that reaches into engine.ts at all.
vi.mock("./engine", () => ({
  sessionBelongsTo: (...args: unknown[]) => sessionBelongsTo(...args),
  getMainPlaylist: vi.fn(),
  getMasterPlaylist: vi.fn(),
  getSegment: vi.fn(),
  MAIN_PLAYLIST_NAME: "main.m3u8",
  PLAYLIST_CONTENT_TYPE: "application/vnd.apple.mpegurl",
  SEGMENT_CONTENT_TYPE: "video/mp2t",
  startSession: vi.fn(),
  stopSession: vi.fn(),
}));

const { addSessionQuery, checkEngineAccess, mapPlaybackError, parseEnginePath } = await import("./engine-routes");

describe("parseEnginePath", () => {
  it("accepts the three shapes the catch-all serves", () => {
    expect(parseEnginePath("e/film-1-original-a1/master.m3u8")).toEqual({ key: "film-1-original-a1", file: "master.m3u8" });
    expect(parseEnginePath("e/film-1-original-a1/main.m3u8")).toEqual({ key: "film-1-original-a1", file: "main.m3u8" });
    expect(parseEnginePath("e/film-1-original-a1/seg_00042.ts")).toEqual({ key: "film-1-original-a1", file: "seg_00042.ts" });
  });

  it("rejects a file name outside the three shapes", () => {
    expect(parseEnginePath("e/film-1-original-a1/evil.txt")).toBeNull();
    expect(parseEnginePath("e/film-1-original-a1/seg_0.ts")).toBeNull(); // not five digits
    expect(parseEnginePath("e/film-1-original-a1/seg_00042.mp4")).toBeNull(); // wrong container
  });

  it("rejects anything without the e/ prefix", () => {
    expect(parseEnginePath("film-1-original-a1/master.m3u8")).toBeNull();
    expect(parseEnginePath("master.m3u8")).toBeNull();
  });

  it("rejects extra path segments -- no directory traversal out of the key's own directory", () => {
    expect(parseEnginePath("e/film-1-original-a1/sub/master.m3u8")).toBeNull();
    expect(parseEnginePath("e/../secret/master.m3u8")).toBeNull();
    expect(parseEnginePath("e/a/b/c")).toBeNull();
  });

  it("rejects a bare 'e/' with nothing after it", () => {
    expect(parseEnginePath("e/")).toBeNull();
    expect(parseEnginePath("e/only-one-segment")).toBeNull();
  });
});

describe("checkEngineAccess", () => {
  const VALID_PS = "0".repeat(32);
  const base = { key: "film-1-original-a1", routeKind: "film" as const, routeId: 1, playSessionId: VALID_PS, deviceId: "dev-1" };

  it("rejects a malformed playSessionId before ever looking at the key", () => {
    expect(checkEngineAccess({ ...base, playSessionId: "not-hex" })).toBe("bad-request");
    expect(checkEngineAccess({ ...base, playSessionId: VALID_PS.slice(0, 31) })).toBe("bad-request");
    expect(sessionBelongsTo).not.toHaveBeenCalled();
  });

  it("rejects a key that doesn't parse as a stream key", () => {
    expect(checkEngineAccess({ ...base, key: "not-a-stream-key" })).toBe("not-found");
  });

  it("rejects a key whose kind or id doesn't match the calling route", () => {
    expect(checkEngineAccess({ ...base, key: "episode-1-original-a1" })).toBe("not-found");
    expect(checkEngineAccess({ ...base, key: "film-2-original-a1" })).toBe("not-found");
  });

  it("rejects when the session doesn't belong to this device for this key", () => {
    sessionBelongsTo.mockReturnValue(false);
    expect(checkEngineAccess(base)).toBe("not-found");
    expect(sessionBelongsTo).toHaveBeenCalledWith(VALID_PS, "dev-1", "film-1-original-a1");
  });

  it("grants access once the key, kind/id and session all agree", () => {
    sessionBelongsTo.mockReturnValue(true);
    expect(checkEngineAccess(base)).toBeNull();
  });
});

describe("addSessionQuery", () => {
  it("stamps only bare segment-file lines, leaving tags and EXTINF alone", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXTINF:6.000000,",
      "seg_00000.ts",
      "#EXTINF:6.000000,",
      "seg_00001.ts",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");
    const out = addSessionQuery(playlist, "abc123");
    expect(out).toContain("seg_00000.ts?ps=abc123");
    expect(out).toContain("seg_00001.ts?ps=abc123");
    expect(out).toContain("#EXTINF:6.000000,");
    expect(out).toContain("#EXT-X-ENDLIST");
    expect(out).not.toContain("#EXTINF:6.000000,?ps=");
  });

  it("never touches a segment name mentioned inside another line", () => {
    // Nothing in this playlist format puts a segment name anywhere but its
    // own line, but the rewrite must not get confused if it ever did.
    const out = addSessionQuery("#EXT-X-COMMENT:seg_00000.ts", "abc123");
    expect(out).toBe("#EXT-X-COMMENT:seg_00000.ts");
  });
});

describe("mapPlaybackError", () => {
  function err(code: PlaybackErrorCode, message = "detail"): PlaybackError {
    return new PlaybackError(code, message);
  }

  it("keeps not-found generic", () => {
    expect(mapPlaybackError(err("not-found", "leaky detail"))).toEqual({ status: 404, message: "not found" });
  });

  it("echoes the message for a caller's own bad input", () => {
    expect(mapPlaybackError(err("invalid-audio-stream", "stream 9 is not audio"))).toEqual({
      status: 400,
      message: "stream 9 is not audio",
    });
    expect(mapPlaybackError(err("not-playable", "no video stream"))).toEqual({ status: 422, message: "no video stream" });
  });

  it("keeps the exact session-cap sentence and its Retry-After", () => {
    const mapped = mapPlaybackError(err("session-cap", "Playback is limited to 2 simultaneous streams..."));
    expect(mapped).toEqual({ status: 503, message: "Playback is limited to 2 simultaneous streams...", retryAfterSecs: 60 });
  });

  it("gives timeout a short, generic Retry-After", () => {
    const mapped = mapPlaybackError(err("timeout", "segment 3 of key was not produced in time"));
    expect(mapped.status).toBe(503);
    expect(mapped.retryAfterSecs).toBe(2);
    expect(mapped.message).not.toContain("segment 3");
  });

  it("treats a request the client abandoned as routine, not a server error", () => {
    // Every seek cancels a fetch or two; that must not read as a 5xx (or as
    // the engine being slow, which is what "timeout" means).
    const mapped = mapPlaybackError(err("aborted", "the request was aborted"));
    expect(mapped.status).toBe(499);
    expect(mapped.retryAfterSecs).toBeUndefined();
  });

  it("keeps ffmpeg/keyframe failure detail out of the response", () => {
    for (const code of ["head-failed", "no-keyframes"] as const) {
      const mapped = mapPlaybackError(err(code, "ffmpeg stderr: /Volumes/media/Movies/Secret Title.mkv exit 1"));
      expect(mapped.status).toBe(502);
      expect(mapped.message).not.toContain("Secret Title");
    }
  });

  it("maps no-disk-space to 507 with a generic message", () => {
    const mapped = mapPlaybackError(err("no-disk-space", "the cache volume has 0.1 GB free"));
    expect(mapped.status).toBe(507);
    expect(mapped.message).not.toContain("GB free");
  });
});
