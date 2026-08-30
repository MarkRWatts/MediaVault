// Shared barcode -> lookup-result resolution, used by both the interactive
// single-scan endpoint (/api/barcode/lookup) and the persistent scan queue's
// processor (/api/scan-queue/process) — see either call site for the fuller
// rationale on why the music/movie paths are split and run concurrently.

import { prisma } from "@/lib/db";
import {
  searchDiscogsByBarcode,
  fetchDiscogsRelease,
  fetchDiscogsMasterMainRelease,
  findAlbumByDiscogsIdentity,
  DISCOGS_URL_RE,
  DISCOGS_MASTER_URL_RE,
} from "@/lib/discogs";
import { searchMovieByTitleYear } from "@/lib/tmdb";
import { lookupMovieByBarcode } from "@/lib/barcode-lookup";
import { guessAlbumMedium } from "@/lib/album-medium";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LookupResult = any;

interface MusicBarcodeHit {
  /** The Discogs master this release belongs to, if any — group-level
   *  identity when present. */
  discogsMasterId: number | null;
  /** The specific release Discogs matched — always present for a
   *  Discogs-sourced hit; doubles as the album's own identity when it has
   *  no master. */
  discogsReleaseId: number;
  title: string;
  artistName: string;
  year: number | null;
  format: string | null;
  coverArtUrl: string | null;
}

async function buildMusicResult(hit: MusicBarcodeHit): Promise<LookupResult> {
  const album = await findAlbumByDiscogsIdentity({
    discogsMasterId: hit.discogsMasterId,
    discogsReleaseId: hit.discogsMasterId == null ? hit.discogsReleaseId : null,
  });
  const albumWithCopies = album
    ? await prisma.album.findUnique({ where: { id: album.id }, include: { physicalCopies: { select: { medium: true } } } })
    : null;

  // Medium-specific: owning this album in SOME form (a CD rip, a different
  // pressing) doesn't mean the exact thing just scanned is already in the
  // collection — scanning an LP barcode for an album you only have on CD
  // should still offer to add the LP, not report "already owned" with no
  // way to log the format actually in hand. Album.owned (digital) only
  // counts toward CD specifically — a digital rip is overwhelmingly
  // CD-sourced in this library, but is never a reasonable signal for vinyl
  // ownership, which is always logged explicitly.
  const scannedMedium = guessAlbumMedium(hit.format);
  const alreadyOwnedInMedium =
    albumWithCopies != null &&
    (albumWithCopies.physicalCopies.some((c) => c.medium === scannedMedium) || (scannedMedium === "CD" && albumWithCopies.owned));

  if (albumWithCopies && alreadyOwnedInMedium) {
    return {
      status: "owned",
      type: "album",
      album: {
        id: albumWithCopies.id,
        title: albumWithCopies.title,
        artistName: hit.artistName,
        year: albumWithCopies.year,
        coverPath: albumWithCopies.coverPath,
      },
    };
  }
  return {
    status: "not_owned",
    type: "album",
    candidate: {
      discogsMasterId: hit.discogsMasterId,
      discogsReleaseId: hit.discogsReleaseId,
      title: hit.title,
      artistName: hit.artistName,
      year: hit.year,
      format: hit.format,
      coverArtUrl: hit.coverArtUrl,
    },
  };
}

export async function resolveMusic(barcode: string): Promise<LookupResult | null> {
  try {
    const hit = await searchDiscogsByBarcode(barcode);
    if (!hit) return null;

    return await buildMusicResult({
      discogsMasterId: hit.masterId,
      discogsReleaseId: hit.discogsReleaseId,
      title: hit.title,
      artistName: hit.artistName,
      year: hit.year,
      format: hit.format,
      coverArtUrl: hit.coverUrl,
    });
  } catch {
    // Discogs lookup failed (rate limit, network, timeout) — never fail the
    // whole request over it, the movie path may still resolve.
    return null;
  }
}

/**
 * Resolve a pasted Discogs release (or master) URL to "already owned" or a
 * not-owned candidate to add — the Scan page's "paste Discogs links" bulk-add
 * tool. A master URL has no tracklist/cover of its own tied to one physical
 * item (see fetchDiscogsMasterMainRelease in discogs.ts) — resolved by
 * following its main_release for display fields, but the identity stored is
 * the master itself (group-level), matching applyManualAlbumDiscogsMatch's
 * own convention. Unlike resolveMusic, network failures are left to
 * propagate — a pasted-URL lookup is a one-off, explicit action, so the
 * caller should surface "Discogs lookup failed" rather than silently
 * swallowing it into a misleading "unknown".
 */
export async function resolveDiscogsUrl(url: string): Promise<LookupResult> {
  const trimmed = url.trim();
  const masterMatch = DISCOGS_MASTER_URL_RE.exec(trimmed);
  const releaseMatch = masterMatch ? null : DISCOGS_URL_RE.exec(trimmed);
  if (!masterMatch && !releaseMatch) return { status: "unknown" };

  const isMaster = masterMatch != null;
  const id = Number((masterMatch ?? releaseMatch)![1]);
  const discogsReleaseId = isMaster ? await fetchDiscogsMasterMainRelease(id) : id;

  const release = await fetchDiscogsRelease(discogsReleaseId);

  return await buildMusicResult({
    discogsMasterId: isMaster ? id : release.masterId,
    discogsReleaseId,
    title: release.title,
    artistName: release.artistName,
    year: release.year,
    format: release.format,
    coverArtUrl: release.coverUrl,
  });
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
