// Manual-fallback title search for the scan page's "Search by title" panel
// (album side). POST { title, artist? } -> top Discogs matches (masters
// preferred, standalone releases as a fallback — see searchDiscogsTitleFallback
// in src/lib/discogs.ts). Mirrors search-movie/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { searchDiscogsTitleFallback, findAlbumByDiscogsIdentity } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

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
    const results = await searchDiscogsTitleFallback(title, artist);

    // Mark which hits are already in the library — same owned definition as
    // scan-resolve.ts's resolveMusic (owned:true OR a physical copy logged),
    // so the "Search by title" panel doesn't leave the user guessing.
    const enriched = await Promise.all(
      results.map(async (r) => {
        const album = await findAlbumByDiscogsIdentity({ discogsMasterId: r.discogsMasterId, discogsReleaseId: r.discogsReleaseId });
        const albumWithCopies = album
          ? await prisma.album.findUnique({ where: { id: album.id }, include: { physicalCopies: { select: { id: true } } } })
          : null;
        const owned = Boolean(albumWithCopies && (albumWithCopies.owned || albumWithCopies.physicalCopies.length > 0));
        return { ...r, owned, albumId: owned ? albumWithCopies!.id : undefined };
      }),
    );

    return NextResponse.json({ results: enriched });
  } catch (err) {
    return NextResponse.json(
      { error: `Discogs search failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
