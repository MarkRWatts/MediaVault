// Resolve a scanned/typed barcode to "already owned" or a not-owned
// candidate to add. Local DB first (instant re-scan, always checked
// regardless of `type` — cheap, and protects against a mislabeled scan). By
// default, the MusicBrainz barcode search (free, authoritative, covers
// CD/vinyl) and the best-effort UPCitemdb -> TMDB fuzzy match (covers
// DVD/Blu-ray/4K, no authoritative free source exists for those) run
// CONCURRENTLY rather than one-after-the-other: a barcode is either a music
// release or a movie, essentially never both, but MusicBrainz's own worst
// case (30s timeout + one retry, see mbFetch in musicbrainz.ts) previously
// blocked every movie scan behind a pointless up-to-a-minute wait before the
// movie lookup even started. An optional `type: "film" | "album"` in the
// request body skips the other path entirely — worth it when the user
// already knows what they're scanning (e.g. working through a stack of
// Blu-rays), since MusicBrainz's 1 req/s throttle otherwise queues every
// single movie scan behind a lookup that was never going to match. See
// PhysicalCopy / FilmPhysicalCopy in prisma/schema.prisma for how "owned" is
// tracked independently of digital ownership.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeBarcode, searchReleaseByBarcode } from "@/lib/musicbrainz";
import { searchMovieByTitleYear } from "@/lib/tmdb";
import { lookupMovieByBarcode } from "@/lib/barcode-lookup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveMusic(barcode: string): Promise<any | null> {
  try {
    const mbHit = await searchReleaseByBarcode(barcode);
    if (!mbHit) return null;

    const album = await prisma.album.findUnique({
      where: { mbid: mbHit.releaseGroupMbid },
      include: { physicalCopies: { select: { id: true } } },
    });
    if (album && (album.owned || album.physicalCopies.length > 0)) {
      return {
        status: "owned",
        type: "album",
        album: {
          id: album.id,
          title: album.title,
          artistName: mbHit.artistName,
          year: album.year,
          coverPath: album.coverPath,
        },
      };
    }
    return {
      status: "not_owned",
      type: "album",
      candidate: {
        mbid: mbHit.releaseGroupMbid,
        title: mbHit.title,
        artistName: mbHit.artistName,
        year: mbHit.year,
        format: mbHit.format,
        coverArtUrl: mbHit.coverArtUrl,
      },
    };
  } catch {
    // MusicBrainz lookup failed (rate limit, network, timeout) — never fail
    // the whole request over it, the movie path may still resolve.
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveMovie(barcode: string): Promise<any | null> {
  if (!process.env.TMDB_API_KEY) return null;

  const upcHit = await lookupMovieByBarcode(barcode);
  if (!upcHit) return null;

  try {
    const movieHit = await searchMovieByTitleYear(upcHit.title, upcHit.year);
    if (!movieHit) return null;

    const film = await prisma.film.findUnique({
      where: { tmdbId: movieHit.tmdbId },
      include: { physicalCopies: { select: { id: true } } },
    });
    if (film && (film.owned || film.physicalCopies.length > 0)) {
      return {
        status: "owned",
        type: "film",
        film: { id: film.id, title: film.title, year: film.year, posterPath: film.posterPath },
      };
    }
    return { status: "not_owned", type: "film", candidate: movieHit };
  } catch {
    // TMDB lookup failed — fall through to unknown.
    return null;
  }
}

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

  // 2 & 3. Music (MusicBrainz) and movie (UPCitemdb -> TMDB) — run whichever
  // path(s) the caller didn't rule out via `type`, concurrently when both
  // are in play (a real barcode only ever matches one of them anyway).
  const type = body.type === "film" || body.type === "album" ? body.type : null;
  const [musicResult, movieResult] = await Promise.all([
    type === "film" ? null : resolveMusic(barcode),
    type === "album" ? null : resolveMovie(barcode),
  ]);
  const result = musicResult ?? movieResult;
  if (result) return NextResponse.json(result);

  return NextResponse.json({ status: "unknown" });
}
