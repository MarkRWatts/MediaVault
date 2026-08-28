import { NextResponse } from "next/server";
import { runJellyfinSync } from "@/lib/jellyfin";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST() {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  try {
    const { runId, started } = await runJellyfinSync();
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId });
  } catch (err) {
    console.error("[api/jellyfin-sync] failed to start sync:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
