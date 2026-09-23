// Route glue for the v4 local engine (V4_PLAN.md, "HTTP contract" and phase
// 4, "Routes, clients, cut-over flag"): the local-engine counterparts of
// jf-routes.ts's three handlers, built to the SAME request/response shape
// so VideoPlayer, the iOS app and the tvOS shell need not know which engine
// answered a given /jf/session, /jf/<playlist-or-segment> or /jf/stop
// request. jf-routes.ts imports these and branches on playbackEngine()
// before touching anything Jellyfin-specific, so its existing Jellyfin
// behaviour stays byte for byte what it was before this file existed.
//
// The engine (engine.ts) names its own stream keys and segment files
// (stream-key.ts) but knows nothing about HTTP; this module's one security
// job is making sure a request can only ever reach its own route family's
// stream key and its own device's session -- see checkEngineAccess -- the
// local equivalent of jellyfin-playback.ts's `lookupPlaybackSession`
// registry check on its proxy.

import { NextResponse } from "next/server";
import { serveFile } from "@/lib/serve-file";
import { parseVariant } from "@/lib/video-playback";
import {
  getMainPlaylist,
  getMasterPlaylist,
  getSegment,
  MAIN_PLAYLIST_NAME,
  PLAYLIST_CONTENT_TYPE,
  SEGMENT_CONTENT_TYPE,
  sessionBelongsTo,
  startSession,
  stopSession,
} from "./engine";
import { PlaybackError, resolveSource, type PlaybackErrorCode, type ResolvedSource } from "./source";
import { parseSegmentFileName, parseStreamKey, SEGMENT_FILE_RE } from "./stream-key";
import type { MediaKind } from "./types";

const PLAY_SESSION_ID_RE = /^[0-9a-f]{32}$/i;

// ---------------------------------------------------------------------------
// Pure helpers -- unit tested directly (engine-routes.test.ts)
// ---------------------------------------------------------------------------

// Direct play (UHD_PLAN.md phase B, "Direct-play routing"): a client that can
// play a plain MP4 URL says so on the session request --
// `?direct=1&vcodecs=h264,hevc` -- and a file it can take as-is is handed
// back as the file itself (`${basePath}/<id>/stream`, byte ranges) instead of
// an engine stream: no segments, no cache, no keyframe index. Opt-in, so a
// client that doesn't ask (today's iOS app) gets HLS exactly as before.
const DIRECT_VIDEO_FAMILIES: Record<string, string> = { h264: "h264", hevc: "hevc", h265: "hevc" };

/** The video codec families a session request declares it can direct-play,
 *  or null when it didn't ask for direct play at all. `vcodecs` defaults to
 *  H.264 -- every client that can open an MP4 URL can decode that. */
export function parseDirectPlayRequest(params: URLSearchParams): Set<string> | null {
  if (params.get("direct") !== "1") return null;
  const declared = (params.get("vcodecs") ?? "h264").split(",").map((c) => DIRECT_VIDEO_FAMILIES[c.trim().toLowerCase()]);
  return new Set(declared.filter((c): c is string => c !== undefined));
}

/** Whether this source can skip the engine: the planner already says it is
 *  playable as-is (MP4-like container, copyable video, a compatible default
 *  audio track -- planVideoPlayback's "direct" tier), its video is a family
 *  the client declared, and the caller isn't asking for a different audio
 *  track than the file's default (switching tracks needs the engine; a
 *  browser can't pick one out of the file).
 *
 *  And the file carries no TrueHD track, even an unplayed one. WebKit
 *  (Safari, and AVPlayer behind it) refuses an MP4 *outright* -- error 4,
 *  "source not supported" -- once its TrueHD track passes ~8.4M samples:
 *  TrueHD stores 1200 samples a second, so that is any film over about two
 *  hours (No Time to Die, 23 Sep 2026). Measured in WebKit against the
 *  library: John Wick at 7.33M samples plays, Blade Runner at 8.47M doesn't
 *  -- straddling 2^23. Chrome plays all of them. The engine's HLS never
 *  carries the TrueHD track, so those files play fine that way. */
export function canDirectPlay(
  source: Pick<ResolvedSource, "plan" | "fileAudioCodecs">,
  clientVideoFamilies: Set<string>,
  requestedAudioStreamIndex: number | null,
): boolean {
  const { plan } = source;
  if (plan.tier !== "direct") return false;
  if (source.fileAudioCodecs.includes("truehd")) return false;
  if (requestedAudioStreamIndex !== null && requestedAudioStreamIndex !== plan.audioStreamIndex) return false;
  const family = DIRECT_VIDEO_FAMILIES[plan.outputVideoCodec ?? ""];
  return family !== undefined && clientVideoFamilies.has(family);
}

/** The only paths the catch-all route serves for the local engine:
 *  `e/<key>/master.m3u8`, `e/<key>/main.m3u8` and `e/<key>/seg_NNNNN.ts`.
 *  The `e/` prefix keeps this namespace syntactically distinct from
 *  Jellyfin's own paths under the same catch-all (jf-routes.ts's JF_PATH_RE)
 *  -- still under /jf for one release (V4_PLAN.md, "HTTP contract"). */
const ENGINE_PATH_RE = /^e\/([^/]+)\/([^/]+)$/;

export interface EnginePathMatch {
  key: string;
  file: string;
}

export function parseEnginePath(subpath: string): EnginePathMatch | null {
  const m = ENGINE_PATH_RE.exec(subpath);
  if (!m) return null;
  const [, key, file] = m;
  if (file !== "master.m3u8" && file !== MAIN_PLAYLIST_NAME && !SEGMENT_FILE_RE.test(file)) return null;
  return { key, file };
}

/** Why a request was refused, kept distinct so the caller can pick the
 *  right status code: a malformed playSessionId is the client's mistake
 *  (400), while a session that doesn't exist, belongs to someone else, or
 *  names the wrong stream key all collapse to "not found" -- there is
 *  nothing a caller should learn from the difference between those three. */
export type AccessDenied = "bad-request" | "not-found";

/**
 * The ownership check every playlist and segment request must pass before
 * the engine is asked for anything: the playSessionId has to parse (32 hex,
 * the same shape jfStop already requires), the key has to belong to the
 * calling route's own kind and id (a film route must not serve an
 * episode's or another film's key), and the session has to be one this
 * device started for exactly that key.
 */
export function checkEngineAccess(input: {
  key: string;
  routeKind: MediaKind;
  routeId: number;
  playSessionId: string;
  deviceId: string;
}): AccessDenied | null {
  if (!PLAY_SESSION_ID_RE.test(input.playSessionId)) return "bad-request";
  const parts = parseStreamKey(input.key);
  if (!parts || parts.kind !== input.routeKind || parts.id !== input.routeId) return "not-found";
  return sessionBelongsTo(input.playSessionId, input.deviceId, input.key) ? null : "not-found";
}

/**
 * Every segment-file line of a rendered main.m3u8 gets the session query
 * appended, so the catch-all route can check ownership on every request a
 * player makes as it follows the playlist. getMainPlaylist (engine.ts)
 * renders plain relative file names -- it has no notion of an HTTP session
 * -- so stamping them is this route layer's job, the same division
 * jellyfin-playback.ts's registry draws (Jellyfin's own playlists already
 * arrive carrying a PlaySessionId). Only lines that are exactly a segment
 * file name are touched; the #EXT-X-* tags and EXTINF lines are untouched.
 */
export function addSessionQuery(playlist: string, playSessionId: string): string {
  return playlist
    .split("\n")
    .map((line) => (SEGMENT_FILE_RE.test(line) ? `${line}?ps=${playSessionId}` : line))
    .join("\n");
}

/**
 * PlaybackError -> the response a route hands back. Every branch keeps the
 * vocabulary jf-routes.ts already uses for the same situations (the exact
 * session-cap sentence, invalid-audio-stream's descriptive message) and,
 * where source.ts's or head.ts's own message could carry a file path or an
 * ffmpeg stderr excerpt, a generic sentence instead -- detail stays in the
 * server log, the same posture jf-routes.ts takes with Jellyfin's errors.
 */
export function mapPlaybackError(err: PlaybackError): { status: number; message: string; retryAfterSecs?: number } {
  const code: PlaybackErrorCode = err.code;
  switch (code) {
    case "not-found":
      return { status: 404, message: "not found" };
    case "invalid-audio-stream":
      return { status: 400, message: err.message };
    case "not-playable":
      return { status: 422, message: err.message };
    case "session-cap":
      return { status: 503, message: err.message, retryAfterSecs: 60 };
    case "timeout":
      return { status: 503, message: "Playback is taking longer than expected — try again.", retryAfterSecs: 2 };
    case "aborted":
      // The client went away mid-request (every seek abandons a fetch or
      // two). Nobody reads this response; 499 keeps it out of the 5xx count.
      return { status: 499, message: "request aborted" };
    case "head-failed":
    case "no-keyframes":
      return { status: 502, message: "Playback could not be started for this file." };
    case "no-disk-space":
      return { status: 507, message: "Not enough space to prepare this file for playback." };
  }
}

/** Detail stays in the server log for every branch -- see mapPlaybackError. */
function logEngineError(context: string, err: unknown): void {
  // Routine, not an error: a seeking player cancels requests in flight.
  if (err instanceof PlaybackError && err.code === "aborted") return;
  if (err instanceof PlaybackError) console.error(`[playback] ${context}: ${err.code}: ${err.message}`);
  else console.error(`[playback] ${context}:`, err);
}

function errorPayload(err: unknown): { status: number; message: string; retryAfterSecs?: number } {
  if (err instanceof PlaybackError) return mapPlaybackError(err);
  // A bug, not a modelled failure -- the same generic 502 jf-routes.ts
  // already returns for an unexpected Jellyfin error.
  return { status: 502, message: "Playback could not be started for this file." };
}

// ---------------------------------------------------------------------------
// Handlers -- jf-routes.ts's local-engine branches
// ---------------------------------------------------------------------------

/**
 * POST .../jf/session, local engine. Same five response fields as
 * jf-routes.ts's Jellyfin branch (source.ts's PlaybackAudioTrack is already
 * `{streamIdx, label}`, so audioTracks needs no remapping), plus `mode`:
 * "hls" for an engine stream, or -- only when the request asked with
 * `?direct=1` -- "direct", where `playlistUrl` is the file's own /stream URL
 * and `playSessionId` is null (see canDirectPlay above).
 */
export async function engineSession(
  req: Request,
  idParam: string,
  kind: MediaKind,
  basePath: string,
  deviceId: string,
): Promise<NextResponse> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "not found" }, { status: 404 });

  const params = new URL(req.url).searchParams;
  const variant = parseVariant(params.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });
  const audioParam = params.get("audio");
  const audioStreamIndex = audioParam === null || audioParam === "" ? null : Number(audioParam);
  if (audioStreamIndex !== null && (!Number.isInteger(audioStreamIndex) || audioStreamIndex < 0 || audioStreamIndex > 999)) {
    return NextResponse.json({ error: "invalid audio stream index" }, { status: 400 });
  }

  // Optional: the session a quality/audio switch supersedes. Anything that
  // isn't a session id is simply ignored -- it is a hint, not a credential
  // (the engine checks ownership before acting on it).
  const replacesParam = params.get("replaces");
  const replaces = replacesParam && /^[0-9a-f]{32}$/i.test(replacesParam) ? replacesParam : null;

  const directFamilies = parseDirectPlayRequest(params);

  try {
    // Direct play only ever replaces the Original rendition: Remote exists to
    // cut the bitrate, which the file itself can't do.
    if (directFamilies && variant === "original") {
      const source = await resolveSource(kind, id, variant, audioStreamIndex);
      if (source && canDirectPlay(source, directFamilies, audioStreamIndex)) {
        return NextResponse.json({
          mode: "direct",
          // Same field the HLS answer uses: "the URL to play". No session
          // exists, so nothing to stop -- playSessionId is null.
          playlistUrl: `${basePath}/${id}/stream`,
          playSessionId: null,
          durationSecs: source.durationSecs,
          transcodeReasons: [],
          audioTracks: source.audioTracks,
        });
      }
    }

    const session = await startSession({ kind, id, variant, audioStreamIndex, deviceId, replaces });
    return NextResponse.json({
      mode: "hls",
      playlistUrl: `${basePath}/${id}/jf/e/${session.key}/master.m3u8?ps=${session.playSessionId}`,
      playSessionId: session.playSessionId,
      durationSecs: session.durationSecs,
      transcodeReasons: session.transcodeReasons,
      audioTracks: session.audioTracks,
    });
  } catch (err) {
    logEngineError(`session for ${basePath}/${id}`, err);
    const { status, message, retryAfterSecs } = errorPayload(err);
    return NextResponse.json(
      { error: message },
      { status, headers: retryAfterSecs !== undefined ? { "Retry-After": String(retryAfterSecs) } : undefined },
    );
  }
}

/**
 * POST .../jf/stop, local engine. Silently ignores a playSessionId this
 * device doesn't own -- the same "unknown ids are ignored" posture as
 * engine.ts's own stopSession/touchSession -- so this endpoint never
 * confirms or denies that some OTHER device's session exists.
 */
export async function engineStop(req: Request, deviceId: string): Promise<NextResponse> {
  const playSessionId = new URL(req.url).searchParams.get("playSessionId") ?? "";
  if (!PLAY_SESSION_ID_RE.test(playSessionId)) {
    return NextResponse.json({ error: "invalid playSessionId" }, { status: 400 });
  }
  if (sessionBelongsTo(playSessionId, deviceId)) {
    await stopSession(playSessionId);
  }
  return new NextResponse(null, { status: 204 });
}

/** GET .../jf/<path>, local engine: the master or main playlist, or one
 *  segment -- see parseEnginePath for the three shapes accepted. */
export async function engineProxy(
  req: Request,
  subpath: string,
  routeKind: MediaKind,
  routeId: number,
  deviceId: string,
): Promise<Response> {
  const parsed = parseEnginePath(subpath);
  if (!parsed) return new NextResponse("not found", { status: 404 });
  const { key, file } = parsed;

  const playSessionId = new URL(req.url).searchParams.get("ps") ?? "";
  const denied = checkEngineAccess({ key, routeKind, routeId, playSessionId, deviceId });
  if (denied === "bad-request") return new NextResponse("invalid playSessionId", { status: 400 });
  if (denied === "not-found") return new NextResponse("not found", { status: 404 });

  try {
    if (file === "master.m3u8") {
      const body = await getMasterPlaylist(key, `${MAIN_PLAYLIST_NAME}?ps=${playSessionId}`, playSessionId);
      return new NextResponse(body, {
        status: 200,
        headers: { "Content-Type": PLAYLIST_CONTENT_TYPE, "Cache-Control": "no-store" },
      });
    }
    if (file === MAIN_PLAYLIST_NAME) {
      const body = await getMainPlaylist(key, playSessionId);
      return new NextResponse(addSessionQuery(body, playSessionId), {
        status: 200,
        headers: { "Content-Type": PLAYLIST_CONTENT_TYPE, "Cache-Control": "no-store" },
      });
    }
    // Anything else that reached here matched SEGMENT_FILE_RE in
    // parseEnginePath, so this can only fail if the two ever disagree.
    const index = parseSegmentFileName(file);
    if (index === null) return new NextResponse("not found", { status: 404 });
    const absPath = await getSegment(key, index, playSessionId, { signal: req.signal });
    return serveFile(req, absPath, SEGMENT_CONTENT_TYPE, "private, max-age=31536000, immutable");
  } catch (err) {
    logEngineError(`${routeKind} ${routeId} ${key}/${file}`, err);
    const { status, message, retryAfterSecs } = errorPayload(err);
    return new NextResponse(message, { status, headers: retryAfterSecs !== undefined ? { "Retry-After": String(retryAfterSecs) } : undefined });
  }
}
