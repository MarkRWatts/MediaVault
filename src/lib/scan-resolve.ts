// Shared barcode -> lookup-result resolution, used by both the interactive
// single-scan endpoint (/api/barcode/lookup) and the persistent scan queue's
// processor (/api/scan-queue/process) — see either call site for the fuller
// rationale on why the music/movie paths are split and run concurrently.

import { prisma } from "@/lib/db";
import { searchReleaseByBarcode, searchReleaseGroupsByTitle, type TitleSearchAlbum } from "@/lib/musicbrainz";
import { searchDiscogsByBarcode, fetchDiscogsRelease, DISCOGS_URL_RE } from "@/lib/discogs";
import { searchMovieByTitleYear } from "@/lib/tmdb";
import { lookupMovieByBarcode } from "@/lib/barcode-lookup";
import { guessAlbumMedium } from "@/lib/album-medium";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LookupResult = any;

interface MusicBarcodeHit {
  releaseGroupMbid: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artistName: string;
  year: number | null;
  format: string | null;
  coverArtUrl: string;
}

/**
 * Pick which title+artist search hit to anchor a Discogs-only release to.
 * MusicBrainz's own relevance ranking (anchors[0]) doesn't know this library
 * may already have a *different* release-group on file for what is really
 * the same record — a promo/EP/compilation variant can outrank the
 * originally-enriched one in a free-text search. Preferring whichever
 * candidate already has an Album row here avoids spawning a duplicate Album
 * for a pressing that's actually already owned (just on another medium).
 */
async function pickAnchor(anchors: TitleSearchAlbum[]): Promise<TitleSearchAlbum | undefined> {
  if (anchors.length === 0) return undefined;
  const owned = await prisma.album.findFirst({
    where: { mbid: { in: anchors.map((a) => a.mbid) } },
    select: { mbid: true },
  });
  return anchors.find((a) => a.mbid === owned?.mbid) ?? anchors[0];
}

async function buildMusicResult(hit: MusicBarcodeHit): Promise<LookupResult> {
  const album = await prisma.album.findUnique({
    where: { mbid: hit.releaseGroupMbid },
    include: { physicalCopies: { select: { medium: true } } },
  });

  // Medium-specific: owning this release-group in SOME form (a CD rip, a
  // different pressing) doesn't mean the exact thing just scanned is
  // already in the collection — scanning an LP barcode for an album you
  // only have on CD should still offer to add the LP, not report "already
  // owned" with no way to log the format actually in hand. Album.owned
  // (digital) only counts toward CD specifically — a digital rip is
  // overwhelmingly CD-sourced in this library (see the all-ALAC backfill),
  // but is never a reasonable signal for vinyl ownership, which is always
  // logged explicitly.
  const scannedMedium = guessAlbumMedium(hit.format);
  const alreadyOwnedInMedium =
    album != null &&
    (album.physicalCopies.some((c) => c.medium === scannedMedium) || (scannedMedium === "CD" && album.owned));

  if (album && alreadyOwnedInMedium) {
    return {
      status: "owned",
      type: "album",
      album: {
        id: album.id,
        title: album.title,
        artistName: hit.artistName,
        year: album.year,
        coverPath: album.coverPath,
      },
    };
  }
  return {
    status: "not_owned",
    type: "album",
    candidate: {
      mbid: hit.releaseGroupMbid,
      releaseMbid: hit.releaseMbid,
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
    const mbHit = await searchReleaseByBarcode(barcode);
    if (mbHit) {
      return await buildMusicResult({
        releaseGroupMbid: mbHit.releaseGroupMbid,
        releaseMbid: mbHit.releaseMbid,
        discogsReleaseId: null,
        title: mbHit.title,
        artistName: mbHit.artistName,
        year: mbHit.year,
        format: mbHit.format,
        coverArtUrl: mbHit.coverArtUrl,
      });
    }
  } catch {
    // MusicBrainz lookup failed (rate limit, network, timeout) — fall
    // through to the Discogs fallback below rather than giving up.
  }

  // MusicBrainz's barcode coverage skews toward CD/digital and misses a lot
  // of newer/smaller-run vinyl (including plain colour-vinyl variants of an
  // otherwise well-known release) — Discogs catches most of what MB misses.
  // A Discogs hit has no MusicBrainz release-group of its own, so one is
  // found by title+artist search to anchor the Album the rest of this app's
  // enrichment/reconciliation machinery expects; if MusicBrainz has never
  // heard of this artist/album at all (not just this pressing), there's
  // nothing safe to auto-create and this falls through to "no match", same
  // as today — same tier of miss as an untagged/obscure release always was.
  try {
    const discogsHit = await searchDiscogsByBarcode(barcode);
    if (!discogsHit) return null;

    const anchors = await searchReleaseGroupsByTitle(discogsHit.title, discogsHit.artistName);
    const anchor = await pickAnchor(anchors);
    if (!anchor) return null;

    return await buildMusicResult({
      releaseGroupMbid: anchor.mbid,
      releaseMbid: null,
      discogsReleaseId: discogsHit.discogsReleaseId,
      title: discogsHit.title,
      artistName: discogsHit.artistName,
      year: discogsHit.year,
      format: discogsHit.format,
      coverArtUrl: discogsHit.coverUrl ?? anchor.coverArtUrl,
    });
  } catch {
    // Discogs lookup failed — never fail the whole request over it, the
    // movie path may still resolve.
    return null;
  }
}

/**
 * Resolve a pasted Discogs release URL to "already owned" or a not-owned
 * candidate to add — the Scan page's "paste Discogs links" bulk-add tool.
 * Mirrors resolveMusic's own Discogs-fallback branch: a Discogs release has
 * no MusicBrainz release-group of its own, so one is found by title+artist
 * search to anchor the Album row the rest of this app's enrichment expects.
 * If MusicBrainz has never heard of this artist/album at all, there's
 * nothing safe to auto-create and this returns "unknown", same tier of miss
 * as an unresolvable barcode. Unlike resolveMusic, network failures are left
 * to propagate — a pasted-URL lookup is a one-off, explicit action, so the
 * caller should surface "Discogs lookup failed" rather than silently
 * swallowing it into a misleading "unknown".
 */
export async function resolveDiscogsUrl(url: string): Promise<LookupResult> {
  const match = DISCOGS_URL_RE.exec(url.trim());
  if (!match) return { status: "unknown" };
  const discogsReleaseId = Number(match[1]);

  const release = await fetchDiscogsRelease(discogsReleaseId);
  const anchors = await searchReleaseGroupsByTitle(release.title, release.artistName);
  const anchor = await pickAnchor(anchors);
  if (!anchor) return { status: "unknown" };

  return await buildMusicResult({
    releaseGroupMbid: anchor.mbid,
    releaseMbid: null,
    discogsReleaseId,
    title: release.title,
    artistName: release.artistName,
    year: release.year,
    format: release.format,
    coverArtUrl: release.coverUrl ?? anchor.coverArtUrl,
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
