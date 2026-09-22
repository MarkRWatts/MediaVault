// POST /api/audio/:trackId/played — the music player's "this track started
// playing" beacon (src/lib/player-engine.ts's reportTrackStart), for the
// anonymous play log (src/lib/play-log.ts). A beacon rather than a side
// effect of the PCM route because that route is also hit by gapless
// prefetches of tracks that may never play.
//
// Two records come out of one beacon, on purpose: the anonymous count in
// PlayLog, which says nothing about who, and the listener's own PlayEvent
// row, which is theirs alone and is what /history reads. Music has no
// resume position, so the event carries a time and nothing else.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logPlay } from "@/lib/play-log";
import { recordPlayEvent } from "@/lib/play-events";
import { requireMemberOrResponse } from "@/lib/require-member";

export async function POST(_req: Request, ctx: { params: Promise<{ trackId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { trackId: trackIdParam } = await ctx.params;
  const trackId = Number(trackIdParam);
  if (!Number.isInteger(trackId)) {
    return NextResponse.json({ error: "invalid track id" }, { status: 400 });
  }
  const exists = await prisma.track.findUnique({ where: { id: trackId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  await logPlay("track", trackId);
  await recordPlayEvent({ userId: gate.userId, kind: "track", itemId: trackId });
  return new NextResponse(null, { status: 204 });
}
