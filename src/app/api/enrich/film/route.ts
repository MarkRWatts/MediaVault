import { NextRequest, NextResponse } from "next/server";
import { hideError } from "@/lib/user-facing-error";
import { runEnrich } from "@/lib/tmdb";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { readForceFlag } from "@/lib/scan-request";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  try {
    const force = await readForceFlag(req);
    const { runId, started } = await runEnrich("FILM", { force });
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId, force });
  } catch (err) {
    console.error("[api/enrich/film] failed to start enrich:", err);
    return NextResponse.json({ error: hideError(err, "api/enrich/film", "Couldn't start that run — the app owner can find the details in the server logs.") }, { status: 500 });
  }
}
