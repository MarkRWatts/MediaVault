// Resolve a scanned/typed barcode to "already owned" or a not-owned
// candidate to add. Order: local DB (instant re-scan), MusicBrainz barcode
// search (free, authoritative, covers CD/vinyl), then a best-effort
// UPCitemdb -> TMDB fuzzy match (covers DVD/Blu-ray/4K, no authoritative
// free source exists for those). See PhysicalCopy / FilmPhysicalCopy in
// prisma/schema.prisma for how "owned" is tracked independently of digital
// ownership.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeBarcode, searchReleaseByBarcode } from "@/lib/musicbrainz";
import { searchMovieByTitleYear } from "@/lib/tmdb";
import { lookupMovieByBarcode } from "@/lib/barcode-lookup";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const barcode = normalizeBarcode(typeof body.barcode === "string" ? body.barcode : "");
  if (!barcode) {
    return NextResponse.json({ error: "expected a valid UPC/EAN barcode" }, { status: 400 });
  }

  // 1. Local DB fast path — a re-scan of something already logged.
  const filmCopy = await prisma.filmPhysicalCopy.findFirst({
    where: { barcode },
    include: { film: { select: { id: true, title: true, year: true, posterPath: true } } },
  });
  if (filmCopy) {
    return NextResponse.json({ status: "owned", type: "film", film: filmCopy.film });
  }

  const albumCopy = await prisma.physicalCopy.findFirst({
    where: { barcode },
    include: { album: { include: { artist: { select: { name: true } } } } },
  });
  if (albumCopy) {
    return NextResponse.json({
      status: "owned",
      type: "album",
      album: {
        id: albumCopy.album.id,
        title: albumCopy.album.title,
        artistName: albumCopy.album.artist.name,
        year: albumCopy.album.year,
        coverPath: albumCopy.album.coverPath,
      },
    });
  }

  // 2. MusicBrainz barcode search — free, no key, exact-match only.
  try {
    const mbHit = await searchReleaseByBarcode(barcode);
    if (mbHit) {
      const album = await prisma.album.findUnique({
        where: { mbid: mbHit.releaseGroupMbid },
        include: { physicalCopies: { select: { id: true } } },
      });
      if (album && (album.owned || album.physicalCopies.length > 0)) {
        return NextResponse.json({
          status: "owned",
          type: "album",
          album: {
            id: album.id,
            title: album.title,
            artistName: mbHit.artistName,
            year: album.year,
            coverPath: album.coverPath,
          },
        });
      }
      return NextResponse.json({
        status: "not_owned",
        type: "album",
        candidate: {
          mbid: mbHit.releaseGroupMbid,
          title: mbHit.title,
          artistName: mbHit.artistName,
          year: mbHit.year,
          format: mbHit.format,
        },
      });
    }
  } catch {
    // MusicBrainz lookup failed (rate limit, network) — fall through to the
    // movie path rather than failing the whole request.
  }

  // 3. Best-effort UPCitemdb -> TMDB fuzzy match (movies).
  if (process.env.TMDB_API_KEY) {
    const upcHit = await lookupMovieByBarcode(barcode);
    if (upcHit) {
      try {
        const movieHit = await searchMovieByTitleYear(upcHit.title, upcHit.year);
        if (movieHit) {
          const film = await prisma.film.findUnique({
            where: { tmdbId: movieHit.tmdbId },
            include: { physicalCopies: { select: { id: true } } },
          });
          if (film && (film.owned || film.physicalCopies.length > 0)) {
            return NextResponse.json({
              status: "owned",
              type: "film",
              film: { id: film.id, title: film.title, year: film.year, posterPath: film.posterPath },
            });
          }
          return NextResponse.json({
            status: "not_owned",
            type: "film",
            candidate: movieHit,
          });
        }
      } catch {
        // TMDB lookup failed — fall through to unknown.
      }
    }
  }

  return NextResponse.json({ status: "unknown" });
}
