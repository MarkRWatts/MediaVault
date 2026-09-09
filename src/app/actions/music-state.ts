"use server";

// Music actions on the signed-in person's own state: the heart on a track
// row, an album page, an artist page (TrackFavourite / AlbumFavourite /
// ArtistFavourite, see prisma/schema.prisma), plus loading the built-in
// "Favourite tracks" list as a queue so the rail can play it without a
// page visit. Mirrors film-state.ts, but gated by requireMember() like
// every other server action — favourites are per person, membership is
// what vouches the person in.
//
// Every toggle revalidates the pages that render the heart AND the root
// layout, because the rail's pinned "Favourite tracks · N" row is rendered
// there (components/shell/app-shell.tsx reads the count per request).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireMember } from "@/lib/require-member";
import { getFavouriteTracks, isPlayableCodec } from "@/lib/queries-music";
import type { QueueTrack } from "@/lib/player-types";

function assertId(id: number, what: string): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid ${what} id`);
}

function revalidateFavourites(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/music");
  revalidatePath("/music/favourites");
  revalidatePath("/", "layout");
}

export async function toggleTrackFavourite(trackId: number): Promise<{ favourite: boolean }> {
  assertId(trackId, "track");
  const { userId } = await requireMember();
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: { codec: true, albumId: true, album: { select: { owned: true } } },
  });
  // A heart is a promise the rail can play it: refuse what the player
  // can't (DRM'd .m4p, unprobed files, a placeholder album with no files).
  if (!track || !track.album.owned || !isPlayableCodec(track.codec)) throw new Error("track is not playable");

  const existing = await prisma.trackFavourite.findUnique({ where: { userId_trackId: { userId, trackId } } });
  if (existing) await prisma.trackFavourite.delete({ where: { userId_trackId: { userId, trackId } } });
  else await prisma.trackFavourite.create({ data: { userId, trackId } });
  revalidateFavourites(`/music/album/${track.albumId}`);
  return { favourite: !existing };
}

export async function toggleAlbumFavourite(albumId: number): Promise<{ favourite: boolean }> {
  assertId(albumId, "album");
  const { userId } = await requireMember();
  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { artistId: true } });
  if (!album) throw new Error("album not found");

  const existing = await prisma.albumFavourite.findUnique({ where: { userId_albumId: { userId, albumId } } });
  if (existing) await prisma.albumFavourite.delete({ where: { userId_albumId: { userId, albumId } } });
  else await prisma.albumFavourite.create({ data: { userId, albumId } });
  revalidateFavourites(`/music/album/${albumId}`, `/music/artist/${album.artistId}`);
  return { favourite: !existing };
}

export async function toggleArtistFavourite(artistId: number): Promise<{ favourite: boolean }> {
  assertId(artistId, "artist");
  const { userId } = await requireMember();
  const artist = await prisma.artist.findUnique({ where: { id: artistId }, select: { id: true } });
  if (!artist) throw new Error("artist not found");

  const existing = await prisma.artistFavourite.findUnique({ where: { userId_artistId: { userId, artistId } } });
  if (existing) await prisma.artistFavourite.delete({ where: { userId_artistId: { userId, artistId } } });
  else await prisma.artistFavourite.create({ data: { userId, artistId } });
  revalidateFavourites(`/music/artist/${artistId}`);
  return { favourite: !existing };
}

/** The tracks behind a rail row, as queue entries, so Play there needs no
 *  page visit. "favourites" is the built-in list; numeric ids are real
 *  playlists (PR3 of PLAYLISTS_PLAN.md — not there yet). */
export async function loadPlaylistQueue(id: "favourites" | number): Promise<QueueTrack[]> {
  const { userId } = await requireMember();
  if (id !== "favourites") throw new Error("playlists are not available yet");
  // Only QueueTrack fields cross to the engine — favouritedAt is a page
  // concern.
  return (await getFavouriteTracks(userId)).map((t) => ({
    trackId: t.trackId,
    title: t.title,
    artist: t.artist,
    albumId: t.albumId,
    albumTitle: t.albumTitle,
    hasCover: t.hasCover,
    coverVersion: t.coverVersion,
    durationSecs: t.durationSecs,
    codec: t.codec,
  }));
}
