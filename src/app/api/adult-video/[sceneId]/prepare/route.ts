// POST /api/adult-video/:sceneId/prepare?variant=… — see
// /api/video/:versionId/prepare for the shared mechanism (video-cache.ts).
// Gated by requireAdultAccessOrResponse, unlike the film route (which relies
// on proxy.ts's blanket signed-in check alone) — the opt-in is a stronger
// boundary than plain household membership.

import { NextResponse } from "next/server";
import { parseVariant, triggerVideoPrepare } from "@/lib/video-cache";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function POST(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  const status = await triggerVideoPrepare("scene", sceneId, variant);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
