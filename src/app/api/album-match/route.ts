// Manual MusicBrainz match: POST { albumId, mb } where `mb` is a
// musicbrainz.org release or release-group URL (or a bare release-group
// UUID). Applies the match immediately; covers/metadata backfill on the
// next enrichment run. See applyManualAlbumMatch in src/lib/musicbrainz.ts.

import { NextRequest, NextResponse } from "next/server";
import { applyManualAlbumMatch } from "@/lib/musicbrainz";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  let body: { albumId?: unknown; mb?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const albumId = Number(body.albumId);
  const mb = typeof body.mb === "string" ? body.mb : "";
  if (!Number.isInteger(albumId) || !mb) {
    return NextResponse.json({ error: "expected { albumId: number, mb: string }" }, { status: 400 });
  }

  const result = await applyManualAlbumMatch(albumId, mb);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
