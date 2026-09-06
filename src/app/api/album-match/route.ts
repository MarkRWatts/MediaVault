// Manual/corrective Discogs match: POST { albumId, discogsUrl } where
// `discogsUrl` is a discogs.com release or master URL. A user-supplied URL
// here is treated as AUTHORITATIVE — it overrides the album's current
// identity/metadata/cover AND resets every physical copy's pressing-level
// Discogs links, since those were resolved under the old (possibly wrong)
// identity. See applyManualAlbumDiscogsMatch in src/lib/discogs.ts.

import { NextRequest, NextResponse } from "next/server";
import { withLookupSlot } from "@/lib/semaphore";
import { readJsonObject } from "@/lib/validation";
import { applyManualAlbumDiscogsMatch } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";

async function handlePost(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { albumId?: unknown; discogsUrl?: unknown };
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

// Bounded concurrency for owner-driven metadata lookups — see lookupSemaphore.
export const POST = withLookupSlot(handlePost);
