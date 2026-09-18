// POST /api/audio/playback — the music player's "a listener pressed Play"
// beacon (src/lib/player-engine.ts's reportPlay, once per fresh queue). It
// exists only to write the usage audit's "audio.playback" row: the PCM
// route can't tell a Play from a gapless prefetch or an auto-advance, so
// the client says so. Content-free like every audit row — no track id.

import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { requireMemberOrResponse } from "@/lib/require-member";

export async function POST() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  await logAudit({ userId: gate.userId, householdId: gate.householdId, action: "audio.playback" });
  return new NextResponse(null, { status: 204 });
}
