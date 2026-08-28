// Register physical ownership for a barcode-scanned item. POST
// { type: "film", tmdbId, medium, barcode? } | { type: "album", mbid, medium,
// barcode? }. Films: find-or-create the Film row (owned stays false unless
// it already had a rip) then upsert a FilmPhysicalCopy. Albums: delegates to
// the existing createPhysicalOnlyAlbum, which already handles find-or-create
// Artist/Album + attach a PhysicalCopy.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { findOrCreateFilmByTmdbId } from "@/lib/tmdb";
import { createPhysicalOnlyAlbum, type PhysicalMedium } from "@/lib/musicbrainz";

const FILM_MEDIA = new Set(["DVD", "BLURAY", "UHD"]);

export async function POST(req: NextRequest) {
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
    const mbid = typeof body.mbid === "string" ? body.mbid : "";
    const rawMedium = typeof body.medium === "string" ? body.medium.toUpperCase() : "";
    if (!mbid || (rawMedium !== "VINYL" && rawMedium !== "CD")) {
      return NextResponse.json(
        { error: "expected { type: 'album', mbid: string, medium: 'VINYL' | 'CD' }" },
        { status: 400 },
      );
    }
    const medium: PhysicalMedium = rawMedium;

    const result = await createPhysicalOnlyAlbum(mbid, medium, { barcode });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ album: result.album });
  }

  return NextResponse.json({ error: "expected type: 'film' | 'album'" }, { status: 400 });
}
