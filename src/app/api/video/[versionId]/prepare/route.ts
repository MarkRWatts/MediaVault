// POST /api/video/:versionId/prepare — idempotent: starts the ffmpeg
// remux/transcode job if one isn't already cached, running, or done, and
// returns immediately with the status the client should now poll on.

import { NextResponse } from "next/server";
import { triggerVideoPrepare } from "@/lib/video-cache";

export async function POST(_req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const status = await triggerVideoPrepare(versionId);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
