// Manual-fallback title search for the scan page's "Search by title" panel
// (album side). POST { title, artist? } -> top MusicBrainz release-group
// matches. Mirrors search-movie/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { searchReleaseGroupsByTitle } from "@/lib/musicbrainz";
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
    const results = await searchReleaseGroupsByTitle(title, artist);

    // Mark which hits are already in the library — same owned definition as
    // scan-resolve.ts's resolveMusic (owned:true OR a physical copy logged),
    // so the "Search by title" panel doesn't leave the user guessing.
    const mbids = results.map((r) => r.mbid);
    const albums = mbids.length
      ? await prisma.album.findMany({
          where: { mbid: { in: mbids } },
          include: { physicalCopies: { select: { id: true } } },
        })
      : [];
    const albumByMbid = new Map(albums.map((a) => [a.mbid, a]));

    const enriched = results.map((r) => {
      const album = albumByMbid.get(r.mbid);
      const owned = Boolean(album && (album.owned || album.physicalCopies.length > 0));
      return { ...r, owned, albumId: owned ? album!.id : undefined };
    });

    return NextResponse.json({ results: enriched });
  } catch (err) {
    return NextResponse.json(
      { error: `MusicBrainz search failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
