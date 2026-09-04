// GET /api/video/:versionId/stream — the original bytes of a direct-playable
// file (already MP4 / H.264-or-HEVC / compatible audio), with normal
// byte-range support so seeking works. Anything that needs preparing is
// served as HLS instead — see ../hls/[variant]/[file]/route.ts and
// PLAYBACK_PLAN.md — and a request here for such a file gets a 409 pointing
// there; the player never sends one, since /status tells it which to use.

import { NextResponse } from "next/server";
import { resolveVideoStream } from "@/lib/video-cache";
import { serveFile } from "@/lib/serve-file";

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const resolved = await resolveVideoStream("film", versionId);
  if (resolved.kind === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (resolved.kind === "needs-prepare") {
    return NextResponse.json({ error: "this file is served as HLS; use hls/<variant>/index.m3u8" }, { status: 409 });
  }
  return serveFile(req, resolved.absPath, resolved.contentType, "no-store");
}
