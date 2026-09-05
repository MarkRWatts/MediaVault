// GET /api/adult-video/:sceneId/stream — see /api/video/:versionId/stream
// for the mechanism; this is the scene-flavoured twin, gated by
// requireAdultAccessOrResponse.

import { NextResponse } from "next/server";
import { resolveVideoStream } from "@/lib/video-cache";
import { serveFile } from "@/lib/serve-file";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function GET(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }

  const resolved = await resolveVideoStream("scene", sceneId);
  if (resolved.kind === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (resolved.kind === "needs-prepare") {
    return NextResponse.json({ error: "this file is served as HLS; use hls/<variant>/index.m3u8" }, { status: 409 });
  }
  return serveFile(req, resolved.absPath, resolved.contentType, "no-store");
}
