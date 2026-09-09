// Per-viewer state the music pages' heart buttons start from — the music
// counterpart of film-user-state.ts. Server-only (Prisma), called by the
// artist and album Server Components alongside their detail queries.

import { prisma } from "@/lib/db";

export async function getArtistUserState(userId: string, artistId: number): Promise<{ favourite: boolean }> {
  const row = await prisma.artistFavourite.findUnique({
    where: { userId_artistId: { userId, artistId } },
    select: { userId: true },
  });
  return { favourite: row !== null };
}

/** The album's own heart plus which of its tracks this person has
 *  hearted, for the tracklist rows. */
export async function getAlbumUserState(
  userId: string,
  albumId: number,
): Promise<{ favourite: boolean; favouriteTrackIds: number[] }> {
  const [album, tracks] = await Promise.all([
    prisma.albumFavourite.findUnique({ where: { userId_albumId: { userId, albumId } }, select: { userId: true } }),
    prisma.trackFavourite.findMany({ where: { userId, track: { albumId } }, select: { trackId: true } }),
  ]);
  return { favourite: album !== null, favouriteTrackIds: tracks.map((t) => t.trackId) };
}
