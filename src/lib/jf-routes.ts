// Route handlers for Jellyfin-brokered and local-engine playback, shared by
// the film (/api/video/<versionId>/jf/*) and episode
// (/api/tv-video/<episodeFileId>/jf/*) routes -- they differ only in how an
// id resolves to a Jellyfin item (jf-viewer.ts) and, for the local engine,
// in which MediaKind their versionId/episodeFileId names. See
// src/lib/jellyfin-playback.ts and src/lib/playback/engine-routes.ts for
// what each branch actually does.
//
// Each handler branches on playbackEngine() FIRST and returns straight out
// of engine-routes.ts for "local" -- the Jellyfin branch below that check is
// completely untouched code, because V4_PLAN.md's cut-over promise is that
// PLAYBACK_ENGINE at its default ("jellyfin") behaves byte for byte as it
// did before this file learned about the local engine.

import { NextResponse } from "next/server";
import { jellyfinConfigured } from "@/lib/jellyfin";
import {
  jellyfinMaxSessions,
  liveSessionCount,
  proxyJellyfinHls,
  startJellyfinPlayback,
  stopJellyfinPlayback,
} from "@/lib/jellyfin-playback";
import { parseVariant } from "@/lib/video-playback";
import { currentViewer } from "@/lib/jf-viewer";
import { ageGateForUser } from "@/lib/age-gate";
import { uhdGate, isUhdVersion } from "@/lib/uhd-gate";
import { playbackEngine } from "@/lib/playback/engine-flag";
import { engineProxy, engineSession, engineStop } from "@/lib/playback/engine-routes";
import type { MediaKind } from "@/lib/playback/types";

type ResolveItem = (id: number) => Promise<string | null>;

// The age-rating gate (src/lib/age-gate.ts) sits inside each branch below
// rather than above the playbackEngine() check, so the Jellyfin path keeps
// the response precedence it always had (an unconfigured server still
// answers 503 before anything else). Free for an unrestricted viewer, which
// is everyone without a date of birth on their Member row.

export async function jfSession(req: Request, idParam: string, resolveItem: ResolveItem, basePath: string, kind: MediaKind) {
  if (playbackEngine() === "local") {
    const viewer = await currentViewer();
    if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    const blocked = await ageGateForUser(viewer.userId, kind, Number(idParam));
    if (blocked) return blocked;
    // A UHD Version streams only with its video copied, to a client that
    // declared the codec -- never converted (canStreamUhd, src/lib/uhd-gate.ts).
    const uhd = await isUhdVersion(kind, Number(idParam));
    return engineSession(req, idParam, kind, basePath, viewer.deviceId, { uhd });
  }

  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const id = Number(idParam);
  const blocked = await ageGateForUser(viewer.userId, kind, id);
  if (blocked) return blocked;
  // Jellyfin could transcode a UHD source, but the app must not offer what
  // the local engine can't finish — the block is about the file, not the
  // backend that happens to be serving it today (src/lib/uhd-gate.ts).
  const uhd = await uhdGate(kind, id);
  if (uhd) return uhd;
  const itemId = await resolveItem(id);
  if (!itemId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const variant = parseVariant(params.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });
  const audioParam = params.get("audio");
  const audioStreamIndex = audioParam === null || audioParam === "" ? null : Number(audioParam);
  if (audioStreamIndex !== null && (!Number.isInteger(audioStreamIndex) || audioStreamIndex < 0 || audioStreamIndex > 999)) {
    return NextResponse.json({ error: "invalid audio stream index" }, { status: 400 });
  }

  // Concurrent-stream cap (see liveSessionCount): each session is a
  // transcode on the Jellyfin host. The player shows this message as-is.
  const max = jellyfinMaxSessions();
  if (liveSessionCount(viewer.deviceId) >= max) {
    return NextResponse.json(
      {
        error: `Playback is limited to ${max} simultaneous stream${max === 1 ? "" : "s"} and ${max === 1 ? "it's" : "they're all"} in use right now — try again in a few minutes.`,
      },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const playback = await startJellyfinPlayback({
      itemId,
      jellyfinUserId: viewer.jellyfinUserId,
      deviceId: viewer.deviceId,
      variant,
      audioStreamIndex,
    });
    return NextResponse.json({
      playlistUrl: `${basePath}/${id}/jf/${playback.playlistPath}`,
      playSessionId: playback.playSessionId,
      durationSecs: playback.runtimeSecs,
      transcodeReasons: playback.transcodeReasons,
      audioTracks: playback.audioTracks,
    });
  } catch (err) {
    // Detail stays in the server log: upstream messages can quote URLs and
    // responses that must not reach a browser.
    console.error(`[jellyfin-playback] session for ${basePath}/${id} failed:`, err);
    return NextResponse.json({ error: "Jellyfin could not start playback for this file." }, { status: 502 });
  }
}

// No age gate here: stop takes a playSessionId, not a media id, and ending
// a transcode is the safe direction — a restricted viewer can't start one.
export async function jfStop(req: Request) {
  if (playbackEngine() === "local") {
    const viewer = await currentViewer();
    if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    return engineStop(req, viewer.deviceId);
  }

  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const playSessionId = new URL(req.url).searchParams.get("playSessionId") ?? "";
  if (!/^[0-9a-f]{32}$/i.test(playSessionId)) return NextResponse.json({ error: "invalid playSessionId" }, { status: 400 });
  await stopJellyfinPlayback(viewer.deviceId, playSessionId);
  return new NextResponse(null, { status: 204 });
}

export async function jfProxy(req: Request, idParam: string, path: string[], resolveItem: ResolveItem, kind: MediaKind) {
  if (playbackEngine() === "local") {
    const viewer = await currentViewer();
    if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) return new NextResponse("not found", { status: 404 });
    // Every playlist and segment, not just the session start: a segment URL
    // must not outlive the viewer's permission to watch it.
    const blocked = await ageGateForUser(viewer.userId, kind, id);
    if (blocked) return blocked;
    // A UHD Version's own copied stream only (canStreamUhd).
    const uhd = await isUhdVersion(kind, id);
    return engineProxy(req, path.join("/"), kind, id, viewer.deviceId, { uhd });
  }

  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const blocked = await ageGateForUser(viewer.userId, kind, Number(idParam));
  if (blocked) return blocked;
  const uhd = await uhdGate(kind, Number(idParam));
  if (uhd) return uhd;
  const itemId = await resolveItem(Number(idParam));
  if (!itemId) return NextResponse.json({ error: "not found" }, { status: 404 });
  return proxyJellyfinHls(itemId, path.join("/"), new URL(req.url).searchParams, viewer.deviceId);
}
