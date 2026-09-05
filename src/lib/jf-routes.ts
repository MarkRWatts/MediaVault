// Route handlers for Jellyfin-brokered playback, shared by the film
// (/api/video/<versionId>/jf/*) and episode (/api/tv-video/<episodeFileId>/jf/*)
// routes -- they differ only in how an id resolves to a Jellyfin item.
// See src/lib/jellyfin-playback.ts for what each does.

import { NextResponse } from "next/server";
import { jellyfinConfigured } from "@/lib/jellyfin";
import { proxyJellyfinHls, startJellyfinPlayback, stopJellyfinPlayback } from "@/lib/jellyfin-playback";
import { parseVariant } from "@/lib/video-playback";
import { currentViewer } from "@/lib/jf-viewer";

type ResolveItem = (id: number) => Promise<string | null>;

export async function jfSession(req: Request, idParam: string, resolveItem: ResolveItem, basePath: string) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const id = Number(idParam);
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

export async function jfStop(req: Request) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const playSessionId = new URL(req.url).searchParams.get("playSessionId") ?? "";
  if (!/^[0-9a-f]{32}$/i.test(playSessionId)) return NextResponse.json({ error: "invalid playSessionId" }, { status: 400 });
  await stopJellyfinPlayback(viewer.deviceId, playSessionId);
  return new NextResponse(null, { status: 204 });
}

export async function jfProxy(req: Request, idParam: string, path: string[], resolveItem: ResolveItem) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const itemId = await resolveItem(Number(idParam));
  if (!itemId) return NextResponse.json({ error: "not found" }, { status: 404 });
  return proxyJellyfinHls(itemId, path.join("/"), new URL(req.url).searchParams, viewer.deviceId);
}
