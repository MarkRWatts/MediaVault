// Shared barcode -> lookup-result resolution, used by both the interactive
// single-scan endpoint (/api/barcode/lookup) and the persistent scan queue's
// processor (/api/scan-queue/process) — see either call site for the fuller
// rationale on why the music/movie paths are split and run concurrently.

import { prisma } from "@/lib/db";
import { searchReleaseByBarcode } from "@/lib/musicbrainz";
import { searchMovieByTitleYear } from "@/lib/tmdb";
import { lookupMovieByBarcode } from "@/lib/barcode-lookup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LookupResult = any;

export async function resolveMusic(barcode: string): Promise<LookupResult | null> {
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

export async function resolveMovie(barcode: string): Promise<LookupResult | null> {
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

/**
 * Local-DB fast path — a re-scan of a barcode already logged against an
 * owned/physical-only Film or Album. Checked unconditionally regardless of
 * a caller's `type` hint (cheap, and protects against a mislabeled scan).
 */
export async function resolveOwned(barcode: string): Promise<LookupResult | null> {
  const filmCopy = await prisma.filmPhysicalCopy.findFirst({
    where: { barcode },
    include: { film: { select: { id: true, title: true, year: true, posterPath: true } } },
  });
  if (filmCopy) {
    return { status: "owned", type: "film", film: filmCopy.film };
  }

  const albumCopy = await prisma.physicalCopy.findFirst({
    where: { barcode },
    include: { album: { include: { artist: { select: { name: true } } } } },
  });
  if (albumCopy) {
    return {
      status: "owned",
      type: "album",
      album: {
        id: albumCopy.album.id,
        title: albumCopy.album.title,
        artistName: albumCopy.album.artist.name,
        year: albumCopy.album.year,
        coverPath: albumCopy.album.coverPath,
      },
    };
  }

  return null;
}

/**
 * Full resolution for one barcode: local DB, then music/movie (whichever
 * `type` doesn't rule out) concurrently. `type` mirrors ScanQueueItem's
 * "auto" | "film" | "album".
 */
export async function resolveBarcode(barcode: string, type: string | null): Promise<LookupResult> {
  const owned = await resolveOwned(barcode);
  if (owned) return owned;

  const [musicResult, movieResult] = await Promise.all([
    type === "film" ? null : resolveMusic(barcode),
    type === "album" ? null : resolveMovie(barcode),
  ]);
  return musicResult ?? movieResult ?? { status: "unknown" };
}

// --- Scan queue row <-> API shape ---

interface ScanQueueItemRow {
  id: number;
  barcode: string;
  mediaType: string;
  status: string;
  resultJson: string | null;
  errorMessage: string | null;
}

export function shapeScanQueueItem(row: ScanQueueItemRow) {
  return {
    id: row.id,
    barcode: row.barcode,
    mediaType: row.mediaType,
    status: row.status,
    result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
    error: row.errorMessage ?? undefined,
  };
}
