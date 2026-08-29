// Resolve a pasted Discogs release URL to "already owned" or a not-owned
// candidate to add — backs the Scan page's "paste Discogs links" bulk-add
// tool. See src/lib/scan-resolve.ts's resolveDiscogsUrl for the actual
// resolution logic (anchors the release to a MusicBrainz release-group by
// title+artist, same as the barcode Discogs fallback).

import { NextRequest, NextResponse } from "next/server";
import { resolveDiscogsUrl } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "expected a Discogs release URL" }, { status: 400 });
  }

  try {
    const result = await resolveDiscogsUrl(url);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Discogs lookup failed" },
      { status: 502 },
    );
  }
}
