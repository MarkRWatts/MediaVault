"use server";

// Music actions on the signed-in person's own state: the heart on a track
// row, an album page, an artist page (TrackFavourite / AlbumFavourite /
// ArtistFavourite, see prisma/schema.prisma), their playlists (Playlist /
// PlaylistItem: create, rename, delete, add, remove, reorder), plus loading
// the built-in "Favourite tracks" list or a playlist as a queue so the
// rail can play it without a page visit. Mirrors film-state.ts, but gated
// by requireMember() like every other server action — favourites and
// playlists are per person, membership is what vouches the person in.
//
// Every toggle revalidates the pages that render the heart AND the root
// layout, because the rail's pinned "Favourite tracks · N" row is rendered
// there (components/shell/app-shell.tsx reads the count per request).

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireMember } from "@/lib/require-member";
import { getFavouriteTracks, isPlayableCodec } from "@/lib/queries-music";
import { getPlaylistDetail, toQueueTracks } from "@/lib/queries-playlists";
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

/** Every owned, playable track id for an album/artist, in the same order
 *  the album/artist page plays them (disc, then track number, nulls last,
 *  title as a final tiebreak) — the track set a freshly-linked playlist is
 *  seeded with. */
async function playableTrackIds(where: Prisma.TrackWhereInput): Promise<number[]> {
  const tracks = await prisma.track.findMany({
    where,
    select: { id: true, disc: true, trackNumber: true, title: true, codec: true },
  });
  return tracks
    .filter((t) => isPlayableCodec(t.codec))
    .sort((a, b) => {
      if (a.disc !== b.disc) return a.disc - b.disc;
      if (a.trackNumber === null && b.trackNumber === null) return a.title.localeCompare(b.title);
      if (a.trackNumber === null) return 1;
      if (b.trackNumber === null) return -1;
      return a.trackNumber - b.trackNumber;
    })
    .map((t) => t.id);
}

/** Create the playlist a freshly-favourited album/artist is linked to,
 *  seeded with every playable track — skipped (favouriting still
 *  succeeds) when there's nothing to put in it. `link` sets exactly one of
 *  sourceAlbumId/sourceArtistId, matching the @@unique pair on Playlist. */
async function createLinkedPlaylist(
  userId: string,
  name: string,
  trackIds: number[],
  link: { sourceAlbumId: number } | { sourceArtistId: number },
): Promise<void> {
  if (trackIds.length === 0) return;
  await prisma.$transaction(async (tx) => {
    const playlist = await tx.playlist.create({ data: { userId, name, ...link } });
    await tx.playlistItem.createMany({
      data: trackIds.map((trackId, position) => ({ playlistId: playlist.id, trackId, position })),
    });
  });
}

export async function toggleAlbumFavourite(albumId: number): Promise<{ favourite: boolean }> {
  assertId(albumId, "album");
  const { userId } = await requireMember();
  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { artistId: true, title: true, artist: { select: { name: true } } },
  });
  if (!album) throw new Error("album not found");

  const existing = await prisma.albumFavourite.findUnique({ where: { userId_albumId: { userId, albumId } } });
  if (existing) {
    await prisma.$transaction([
      prisma.albumFavourite.delete({ where: { userId_albumId: { userId, albumId } } }),
      prisma.playlist.deleteMany({ where: { userId, sourceAlbumId: albumId } }), // items cascade
    ]);
  } else {
    await prisma.albumFavourite.create({ data: { userId, albumId } });
    const trackIds = await playableTrackIds({ albumId, album: { owned: true } });
    await createLinkedPlaylist(userId, `${album.artist.name} — ${album.title}`, trackIds, { sourceAlbumId: albumId });
  }
  revalidateFavourites(`/music/album/${albumId}`, `/music/artist/${album.artistId}`);
  return { favourite: !existing };
}

export async function toggleArtistFavourite(artistId: number): Promise<{ favourite: boolean }> {
  assertId(artistId, "artist");
  const { userId } = await requireMember();
  const artist = await prisma.artist.findUnique({ where: { id: artistId }, select: { id: true, name: true } });
  if (!artist) throw new Error("artist not found");

  const existing = await prisma.artistFavourite.findUnique({ where: { userId_artistId: { userId, artistId } } });
  if (existing) {
    await prisma.$transaction([
      prisma.artistFavourite.delete({ where: { userId_artistId: { userId, artistId } } }),
      prisma.playlist.deleteMany({ where: { userId, sourceArtistId: artistId } }), // items cascade
    ]);
  } else {
    await prisma.artistFavourite.create({ data: { userId, artistId } });
    const trackIds = await playableTrackIds({ album: { artistId, owned: true } });
    await createLinkedPlaylist(userId, artist.name, trackIds, { sourceArtistId: artistId });
  }
  revalidateFavourites(`/music/artist/${artistId}`);
  return { favourite: !existing };
}

/** The tracks behind a rail row, as queue entries, so Play there needs no
 *  page visit. "favourites" is the built-in list; a number is one of the
 *  person's own playlists. */
export async function loadPlaylistQueue(id: "favourites" | number): Promise<QueueTrack[]> {
  const { userId } = await requireMember();
  if (id === "favourites") {
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
  assertId(id, "playlist");
  const detail = await getPlaylistDetail(userId, id);
  if (!detail) throw new Error("Playlist not found");
  return toQueueTracks(detail.items);
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

const PLAYLIST_NAME_MAX = 80;
/** Cap per addTracksToPlaylist call — an album is a few dozen tracks; a
 *  whole-library dump isn't a playlist. */
const PLAYLIST_ADD_MAX = 500;

function cleanPlaylistName(raw: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0 || name.length > PLAYLIST_NAME_MAX) {
    throw new Error(`Playlist name must be 1–${PLAYLIST_NAME_MAX} characters`);
  }
  return name;
}

/** One message for "doesn't exist" and "isn't yours" — telling them apart
 *  would confirm another person's playlist ids. */
async function ownedPlaylist(userId: string, playlistId: number): Promise<{ id: number }> {
  assertId(playlistId, "playlist");
  const row = await prisma.playlist.findFirst({ where: { id: playlistId, userId }, select: { id: true } });
  if (!row) throw new Error("Playlist not found");
  return row;
}

function revalidatePlaylist(playlistId: number) {
  revalidatePath(`/music/playlist/${playlistId}`);
  revalidatePath("/", "layout"); // the rail's list + counts
}

export async function createPlaylist(rawName: string): Promise<{ id: number }> {
  const name = cleanPlaylistName(rawName);
  const { userId } = await requireMember();
  const created = await prisma.playlist.create({ data: { userId, name }, select: { id: true } });
  revalidatePlaylist(created.id);
  return { id: created.id };
}

export async function renamePlaylist(playlistId: number, rawName: string): Promise<{ name: string }> {
  const name = cleanPlaylistName(rawName);
  const { userId } = await requireMember();
  const playlist = await ownedPlaylist(userId, playlistId);
  await prisma.playlist.update({ where: { id: playlist.id }, data: { name } });
  revalidatePlaylist(playlist.id);
  return { name };
}

export async function deletePlaylist(playlistId: number): Promise<void> {
  const { userId } = await requireMember();
  const playlist = await ownedPlaylist(userId, playlistId);
  await prisma.playlist.delete({ where: { id: playlist.id } }); // items cascade
  revalidatePlaylist(playlist.id);
  revalidatePath("/music");
}

/** Append tracks in the order given. Skips ids already in the playlist,
 *  duplicates within the call, and anything the player can't play (DRM,
 *  unprobed, or an album with no files) — so "Add album" is idempotent
 *  and a heart-able track is always a playlist-able one. Positions stay
 *  dense: new items take max(position)+1 onward. */
export async function addTracksToPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<{ added: number; skipped: number }> {
  if (!Array.isArray(trackIds)) throw new Error("invalid track ids");
  if (trackIds.length > PLAYLIST_ADD_MAX) throw new Error(`at most ${PLAYLIST_ADD_MAX} tracks per add`);
  for (const id of trackIds) assertId(id, "track");
  const { userId } = await requireMember();
  const playlist = await ownedPlaylist(userId, playlistId);
  if (trackIds.length === 0) return { added: 0, skipped: 0 };

  const [playable, existing, last] = await Promise.all([
    prisma.track.findMany({
      where: { id: { in: trackIds }, album: { owned: true } },
      select: { id: true, codec: true },
    }),
    prisma.playlistItem.findMany({ where: { playlistId: playlist.id }, select: { trackId: true } }),
    prisma.playlistItem.findFirst({
      where: { playlistId: playlist.id },
      orderBy: { position: "desc" },
      select: { position: true },
    }),
  ]);
  const playableIds = new Set(playable.filter((t) => isPlayableCodec(t.codec)).map((t) => t.id));
  const present = new Set(existing.map((e) => e.trackId));

  const toAdd: number[] = [];
  for (const id of trackIds) {
    if (!playableIds.has(id) || present.has(id)) continue;
    present.add(id); // dedupes repeats within this call too
    toAdd.push(id);
  }
  if (toAdd.length === 0) return { added: 0, skipped: trackIds.length };

  let position = (last?.position ?? -1) + 1;
  await prisma.$transaction([
    prisma.playlistItem.createMany({
      data: toAdd.map((trackId) => ({ playlistId: playlist.id, trackId, position: position++ })),
    }),
    prisma.playlist.update({ where: { id: playlist.id }, data: { updatedAt: new Date() } }),
  ]);
  revalidatePlaylist(playlist.id);
  return { added: toAdd.length, skipped: trackIds.length - toAdd.length };
}

/** Rewrite every item's position to its index in `orderedIds`, touching
 *  only rows whose position actually changes, in one transaction. Used by
 *  remove (close the gap) and move. */
async function renumber(playlistId: number, orderedIds: number[], current: Map<number, number>) {
  const updates = orderedIds
    .map((id, index) => ({ id, index }))
    .filter(({ id, index }) => current.get(id) !== index)
    .map(({ id, index }) => prisma.playlistItem.update({ where: { id }, data: { position: index } }));
  await prisma.$transaction([
    ...updates,
    prisma.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } }),
  ]);
}

export async function removePlaylistItem(playlistId: number, itemId: number): Promise<void> {
  assertId(itemId, "item");
  const { userId } = await requireMember();
  const playlist = await ownedPlaylist(userId, playlistId);
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  if (!items.some((it) => it.id === itemId)) throw new Error("Track is not in this playlist");
  await prisma.playlistItem.delete({ where: { id: itemId } });
  const remaining = items.filter((it) => it.id !== itemId);
  await renumber(
    playlist.id,
    remaining.map((it) => it.id),
    new Map(remaining.map((it) => [it.id, it.position])),
  );
  revalidatePlaylist(playlist.id);
}

/** Move one item to `toPosition` (clamped to the list), shifting the
 *  others. Up/down buttons pass position ∓ 1. */
export async function movePlaylistItem(playlistId: number, itemId: number, toPosition: number): Promise<void> {
  assertId(itemId, "item");
  if (!Number.isInteger(toPosition)) throw new Error("invalid position");
  const { userId } = await requireMember();
  const playlist = await ownedPlaylist(userId, playlistId);
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  const from = items.findIndex((it) => it.id === itemId);
  if (from === -1) throw new Error("Track is not in this playlist");
  const to = Math.min(Math.max(toPosition, 0), items.length - 1);
  if (from === to) return;
  const ids = items.map((it) => it.id);
  ids.splice(from, 1);
  ids.splice(to, 0, itemId);
  await renumber(playlist.id, ids, new Map(items.map((it) => [it.id, it.position])));
  revalidatePlaylist(playlist.id);
}
