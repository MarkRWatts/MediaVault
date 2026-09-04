// POST /api/video/:versionId/prepare?variant=original|remote — idempotent:
// starts the ffmpeg job for that variant if one isn't already cached or
// running, and returns immediately with the status the client should now
// poll on. Optional pre-warming; the HLS playlist route self-starts too.

import { NextResponse } from "next/server";
import { parseVariant, triggerVideoPrepare } from "@/lib/video-cache";

export async function POST(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  const status = await triggerVideoPrepare("film", versionId, variant);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
