import { NextResponse } from "next/server";
import { hideError } from "@/lib/user-facing-error";
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
    return NextResponse.json({ error: hideError(err, "api/jellyfin-sync", "Couldn't start that run — the app owner can find the details in the server logs.") }, { status: 500 });
  }
}
