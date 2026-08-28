// Manual-fallback title search for the scan page's "Search by title" panel
// (album side). POST { title, artist? } -> top MusicBrainz release-group
// matches. Mirrors search-movie/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { searchReleaseGroupsByTitle } from "@/lib/musicbrainz";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "expected { title: string }" }, { status: 400 });
  }
  const artist = typeof body.artist === "string" && body.artist.trim() ? body.artist.trim() : undefined;

  try {
    const results = await searchReleaseGroupsByTitle(title, artist);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: `MusicBrainz search failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
