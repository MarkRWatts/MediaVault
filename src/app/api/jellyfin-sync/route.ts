import { NextResponse } from "next/server";
import { runJellyfinSync } from "@/lib/jellyfin";

export async function POST() {
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
