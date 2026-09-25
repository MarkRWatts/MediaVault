// Turns scan-resolve.ts's LookupResult (the web Scan page's untyped shape)
// into GET /api/v1/barcode/:code's typed BarcodeLookupResponse, adding the
// one thing the web page doesn't need but a shop-aisle "do I have this?"
// check does: every format the matched film or album is already owned in,
// so a not-owned LP can say "you have it on CD".

import { prisma } from "@/lib/db";
import { findAlbumByDiscogsIdentity } from "@/lib/discogs";
import { guessAlbumMedium } from "@/lib/album-medium";
import type { LookupResult } from "@/lib/scan-resolve";
import type { BarcodeLookupResponse, BarcodeMatch, BarcodeMedium, BarcodeOwnedCopy } from "@/lib/api-v1-types";

// Most useful first: the scarcer, "better" physical formats ahead of the
// everyday ones, and a digital rip last.
const MEDIUM_ORDER: BarcodeMedium[] = ["VINYL", "CD", "UHD", "BLURAY", "DVD", "DIGITAL"];

function asMedium(value: unknown): BarcodeMedium | null {
  return typeof value === "string" && (MEDIUM_ORDER as string[]).includes(value) ? (value as BarcodeMedium) : null;
}

/** Physical copies plus a digital rip, one entry per medium+format, ordered
 *  by MEDIUM_ORDER. Unrecognised media (a future CASSETTE) are kept, last. */
export function ownedAsFrom(
  copies: { medium: string; format?: string | null }[],
  digitallyOwned: boolean,
): BarcodeOwnedCopy[] {
  const seen = new Set<string>();
  const out: BarcodeOwnedCopy[] = [];
  for (const copy of copies) {
    const format = copy.format ?? null;
    const key = `${copy.medium}|${format ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ medium: copy.medium as BarcodeMedium, format });
  }
  if (digitallyOwned) out.push({ medium: "DIGITAL", format: null });
  const rank = (m: string) => {
    const i = (MEDIUM_ORDER as string[]).indexOf(m);
    return i === -1 ? MEDIUM_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.medium) - rank(b.medium));
}

function posterArtwork(posterPath: string | null | undefined): string | null {
  return posterPath ? `/api/poster/w342${posterPath}` : null;
}

async function filmOwnership(filmId: number) {
  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: { owned: true, physicalCopies: { select: { medium: true } } },
  });
  return film ? ownedAsFrom(film.physicalCopies, film.owned) : [];
}

async function albumOwnership(albumId: number) {
  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { owned: true, coverPath: true, updatedAt: true, physicalCopies: { select: { medium: true, format: true } } },
  });
  if (!album) return null;
  return {
    ownedAs: ownedAsFrom(album.physicalCopies, album.owned),
    artwork: album.coverPath ? `/api/cover/${albumId}?v=${album.updatedAt.getTime()}&size=512` : null,
  };
}

export async function toBarcodeResponse(barcode: string, result: LookupResult): Promise<BarcodeLookupResponse> {
  const status = result?.status;
  if (status !== "owned" && status !== "not_owned") {
    return { barcode, status: "unknown", match: null };
  }

  let match: BarcodeMatch;
  if (result.type === "film" && status === "owned") {
    const film = result.film;
    match = {
      kind: "film",
      title: film.title,
      artistName: null,
      year: film.year ?? null,
      scannedMedium: asMedium(result.medium),
      libraryId: film.id,
      artwork: posterArtwork(film.posterPath),
      ownedAs: await filmOwnership(film.id),
    };
  } else if (result.type === "film") {
    const candidate = result.candidate;
    // An unowned placeholder row (a collection's missing entry) may exist.
    const film = await prisma.film.findUnique({ where: { tmdbId: candidate.tmdbId }, select: { id: true } });
    match = {
      kind: "film",
      title: candidate.title,
      artistName: null,
      year: candidate.year ?? null,
      scannedMedium: null,
      libraryId: film?.id ?? null,
      artwork: posterArtwork(candidate.posterPath),
      ownedAs: film ? await filmOwnership(film.id) : [],
    };
  } else if (status === "owned") {
    const album = result.album;
    const owned = await albumOwnership(album.id);
    match = {
      kind: "album",
      title: album.title,
      artistName: album.artistName ?? null,
      year: album.year ?? null,
      scannedMedium: asMedium(result.medium),
      libraryId: album.id,
      artwork: owned?.artwork ?? null,
      ownedAs: owned?.ownedAs ?? [],
    };
  } else {
    const candidate = result.candidate;
    const album = await findAlbumByDiscogsIdentity({
      discogsMasterId: candidate.discogsMasterId ?? null,
      discogsReleaseId: candidate.discogsMasterId == null ? (candidate.discogsReleaseId ?? null) : null,
    });
    const owned = album ? await albumOwnership(album.id) : null;
    match = {
      kind: "album",
      title: candidate.title,
      artistName: candidate.artistName ?? null,
      year: candidate.year ?? null,
      scannedMedium: guessAlbumMedium(candidate.format ?? null),
      libraryId: album?.id ?? null,
      // The pressing actually scanned, rather than the library's own cover.
      artwork: candidate.coverArtUrl ?? owned?.artwork ?? null,
      ownedAs: owned?.ownedAs ?? [],
    };
  }

  return { barcode, status, match };
}
