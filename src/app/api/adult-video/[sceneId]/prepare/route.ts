// POST /api/adult-video/:sceneId/prepare — see /api/video/:versionId/prepare
// for the shared mechanism (video-cache.ts). Gated by
// requireAdultAccessOrResponse, unlike the film route (which relies on
// proxy.ts's blanket signed-in check alone) — the opt-in is a stronger
// boundary than plain household membership.

import { NextResponse } from "next/server";
import { triggerVideoPrepare } from "@/lib/video-cache";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function POST(_req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }

  const status = await triggerVideoPrepare("scene", sceneId);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
