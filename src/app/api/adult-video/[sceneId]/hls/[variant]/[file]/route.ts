// GET /api/adult-video/:sceneId/hls/:variant/:file — see
// /api/video/:versionId/hls for the mechanism; this is the scene-flavoured
// twin, gated by requireAdultAccessOrResponse on every request (segments
// included — a segment URL must not outlive the viewer's access).

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { PLAYLIST_NAME, parseVariant, resolveHlsFile, resolveHlsPlaylist } from "@/lib/video-cache";
import { serveFile } from "@/lib/serve-file";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ sceneId: string; variant: string; file: string }> },
) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam, variant: variantParam, file } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }
  const variant = parseVariant(variantParam);
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  if (file === PLAYLIST_NAME) {
    const resolved = await resolveHlsPlaylist("scene", sceneId, variant);
    if (resolved.kind === "not-found") return NextResponse.json({ error: "not found" }, { status: 404 });
    if (resolved.kind === "direct") return NextResponse.json({ error: "direct-play file; use /stream" }, { status: 409 });
    if (resolved.kind === "error") return NextResponse.json({ error: resolved.message }, { status: 500 });
    if (resolved.kind === "not-started") {
      return NextResponse.json({ error: "not ready yet" }, { status: 503, headers: { "Retry-After": "2" } });
    }
    const body = await fs.readFile(resolved.absPath, "utf8");
    return new NextResponse(body, {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
    });
  }

  const segment = await resolveHlsFile("scene", sceneId, variant, file);
  if (!segment) return NextResponse.json({ error: "not found" }, { status: 404 });
  return serveFile(req, segment.absPath, segment.contentType, "private, max-age=31536000, immutable");
}
