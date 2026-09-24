// POST /api/v1/diagnostics/playback — a native player's running account of
// one viewing (src/lib/playback-diagnostics.ts), written to the server log.
// Nothing is stored.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { formatPlaybackReport, parsePlaybackReport } from "@/lib/playback-diagnostics";

export async function POST(req: Request) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const report = parsePlaybackReport(await req.json().catch(() => null));
  if (!report) return NextResponse.json({ error: "invalid report" }, { status: 400 });

  for (const line of formatPlaybackReport(report, gate.userId)) console.log(line);
  return NextResponse.json({ ok: true });
}
