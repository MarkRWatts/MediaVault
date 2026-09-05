// GET /api/video/:versionId/status?variant=original|remote — tells
// VideoPlayer.tsx what to do next: "direct" (point <video> at /stream),
// "ready"/"preparing"/"idle" (play the HLS playlist, which self-starts the
// job), or give up ("error"/404). See src/lib/video-cache.ts for the state
// machine and PLAYBACK_PLAN.md for the variants.

import { NextResponse } from "next/server";
import { getVideoStatus, parseVariant } from "@/lib/video-cache";

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  const status = await getVideoStatus("film", versionId, variant);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
