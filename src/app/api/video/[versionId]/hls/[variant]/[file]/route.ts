// GET /api/video/:versionId/hls/:variant/:file — the HLS playlist and its
// segments for a prepared film (PLAYBACK_PLAN.md). `:file` is either
// `index.m3u8` (self-starting: kicks off the ffmpeg job if nothing's cached
// or running, waits for the first segment, then serves the event playlist)
// or one of the whitelisted segment names (`init.mp4`, `seg_NNNNN.m4s`),
// served with byte ranges and a long cache lifetime — a written segment is
// immutable. Direct-playable files never come here; the player uses
// /stream for those.

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { PLAYLIST_NAME, parseVariant, resolveHlsFile, resolveHlsPlaylist } from "@/lib/video-cache";
import { serveFile } from "@/lib/serve-file";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ versionId: string; variant: string; file: string }> },
) {
  const { versionId: versionIdParam, variant: variantParam, file } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }
  const variant = parseVariant(variantParam);
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  if (file === PLAYLIST_NAME) {
    const resolved = await resolveHlsPlaylist("film", versionId, variant);
    if (resolved.kind === "not-found") return NextResponse.json({ error: "not found" }, { status: 404 });
    if (resolved.kind === "direct") return NextResponse.json({ error: "direct-play file; use /stream" }, { status: 409 });
    if (resolved.kind === "error") return NextResponse.json({ error: resolved.message }, { status: 500 });
    if (resolved.kind === "not-started") {
      return NextResponse.json({ error: "not ready yet" }, { status: 503, headers: { "Retry-After": "2" } });
    }
    const body = await fs.readFile(resolved.absPath, "utf8");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // Grows as segments land; never let a proxy or the browser keep it.
        "Cache-Control": "no-store",
      },
    });
  }

  const segment = await resolveHlsFile("film", versionId, variant, file);
  if (!segment) return NextResponse.json({ error: "not found" }, { status: 404 });
  return serveFile(req, segment.absPath, segment.contentType, "private, max-age=31536000, immutable");
}
