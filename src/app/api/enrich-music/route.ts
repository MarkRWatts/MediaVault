import { NextResponse } from "next/server";
import { runMusicEnrich } from "@/lib/musicbrainz";

export async function POST() {
  try {
    const { runId, started } = await runMusicEnrich();
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId });
  } catch (err) {
    console.error("[api/enrich-music] failed to start enrich:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
