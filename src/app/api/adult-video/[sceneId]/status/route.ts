// GET /api/adult-video/:sceneId/status?variant=… — see /api/video/:versionId/status.

import { NextResponse } from "next/server";
import { getVideoStatus, parseVariant } from "@/lib/video-cache";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function GET(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  const status = await getVideoStatus("scene", sceneId, variant);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
