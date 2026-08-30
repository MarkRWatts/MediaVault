// Manual/corrective Discogs match: POST { albumId, discogsUrl } where
// `discogsUrl` is a discogs.com release or master URL. A user-supplied URL
// here is treated as AUTHORITATIVE — it overrides the album's current
// identity/metadata/cover AND resets every physical copy's pressing-level
// Discogs links, since those were resolved under the old (possibly wrong)
// identity. See applyManualAlbumDiscogsMatch in src/lib/discogs.ts.

import { NextRequest, NextResponse } from "next/server";
import { applyManualAlbumDiscogsMatch } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  let body: { albumId?: unknown; discogsUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const albumId = Number(body.albumId);
  const discogsUrl = typeof body.discogsUrl === "string" ? body.discogsUrl : "";
  if (!Number.isInteger(albumId) || !discogsUrl) {
    return NextResponse.json({ error: "expected { albumId: number, discogsUrl: string }" }, { status: 400 });
  }

  const result = await applyManualAlbumDiscogsMatch(albumId, discogsUrl);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
