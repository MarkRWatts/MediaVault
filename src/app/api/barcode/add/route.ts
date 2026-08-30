// Register physical ownership for a barcode-scanned item. POST
// { type: "film", tmdbId, medium, barcode? } | { type: "album",
// discogsMasterId, discogsReleaseId, medium, barcode? }. Films: find-or-create
// the Film row (owned stays false unless it already had a rip) then upsert a
// FilmPhysicalCopy. Albums: delegates to the existing createPhysicalOnlyAlbum,
// which already handles find-or-create Artist/Album + attach a PhysicalCopy
// (and, given a specific discogsReleaseId, its pressing-specific tracklist/
// cover — no separate attach step needed here).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { findOrCreateFilmByTmdbId } from "@/lib/tmdb";
import { createPhysicalOnlyAlbum, type PhysicalMedium } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";

const FILM_MEDIA = new Set(["DVD", "BLURAY", "UHD"]);

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const barcode = typeof body.barcode === "string" ? body.barcode : undefined;

  if (body.type === "film") {
    const tmdbId = Number(body.tmdbId);
    const medium = typeof body.medium === "string" ? body.medium.toUpperCase() : "";
    if (!Number.isInteger(tmdbId) || !FILM_MEDIA.has(medium)) {
      return NextResponse.json(
        { error: "expected { type: 'film', tmdbId: number, medium: 'DVD' | 'BLURAY' | 'UHD' }" },
        { status: 400 },
      );
    }

    let film;
    try {
      film = await findOrCreateFilmByTmdbId(tmdbId);
    } catch (err) {
      return NextResponse.json(
        { error: `TMDB lookup failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const copy = await prisma.filmPhysicalCopy.upsert({
      where: { filmId_medium: { filmId: film.id, medium } },
      create: { filmId: film.id, medium, barcode: barcode || null },
      update: { barcode: barcode || null },
    });

    return NextResponse.json({ film, copy });
  }

  if (body.type === "album") {
    const discogsMasterId = Number.isInteger(body.discogsMasterId) ? (body.discogsMasterId as number) : null;
    const discogsReleaseId = Number.isInteger(body.discogsReleaseId) ? (body.discogsReleaseId as number) : null;
    const rawMedium = typeof body.medium === "string" ? body.medium.toUpperCase() : "";
    if ((discogsMasterId == null && discogsReleaseId == null) || (rawMedium !== "VINYL" && rawMedium !== "CD")) {
      return NextResponse.json(
        {
          error:
            "expected { type: 'album', discogsMasterId?: number, discogsReleaseId?: number, medium: 'VINYL' | 'CD' }",
        },
        { status: 400 },
      );
    }
    const medium: PhysicalMedium = rawMedium;

    // A barcode-resolved hit always carries the specific pressing that was
    // scanned (discogsReleaseId) — pass both facts through directly so
    // createPhysicalOnlyAlbum populates that exact pressing's tracklist/
    // cover, not just whatever its master's arbitrary main_release is. A
    // title-search pick only knows the master OR a standalone release (no
    // barcode was scanned), so a master-only pick is passed as a URL —
    // createPhysicalOnlyAlbum resolves it via main_release.
    const ref =
      discogsReleaseId != null
        ? { discogsMasterId, discogsReleaseId }
        : `https://www.discogs.com/master/${discogsMasterId}`;

    const result = await createPhysicalOnlyAlbum(ref, medium, { barcode });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ album: result.album });
  }

  return NextResponse.json({ error: "expected type: 'film' | 'album'" }, { status: 400 });
}
