// GET /api/video/:versionId/status — tells VideoPlayer.tsx what to do next:
// play immediately ("direct"/"ready"), keep polling ("preparing"/"idle"), or
// give up ("error"/404). See src/lib/video-cache.ts for the state machine.

import { NextResponse } from "next/server";
import { getVideoStatus } from "@/lib/video-cache";

export async function GET(_req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const status = await getVideoStatus(versionId);
  if (status.state === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(status);
}
