// Manual-fallback title search for the scan page, used when a barcode
// can't be resolved automatically (no UPC match, or TMDB couldn't confirm
// the UPC title guess). POST { title, year? } -> top TMDB matches.

import { NextRequest, NextResponse } from "next/server";
import { searchMoviesByTitle } from "@/lib/tmdb";
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
  const year = Number.isInteger(body.year) ? (body.year as number) : undefined;

  if (!process.env.TMDB_API_KEY) {
    return NextResponse.json({ error: "TMDB_API_KEY not set" }, { status: 503 });
  }

  try {
    const results = await searchMoviesByTitle(title, year);

    // Mark which hits are already in the library — same owned definition as
    // scan-resolve.ts's resolveMovie (owned:true OR a physical copy logged),
    // so the "Search by title" panel doesn't leave the user guessing.
    const tmdbIds = results.map((r) => r.tmdbId);
    const films = tmdbIds.length
      ? await prisma.film.findMany({
          where: { tmdbId: { in: tmdbIds } },
          include: { physicalCopies: { select: { id: true } } },
        })
      : [];
    const filmByTmdbId = new Map(films.map((f) => [f.tmdbId, f]));

    const enriched = results.map((r) => {
      const film = filmByTmdbId.get(r.tmdbId);
      const owned = Boolean(film && (film.owned || film.physicalCopies.length > 0));
      return { ...r, owned, filmId: owned ? film!.id : undefined };
    });

    return NextResponse.json({ results: enriched });
  } catch (err) {
    return NextResponse.json(
      { error: `TMDB search failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
