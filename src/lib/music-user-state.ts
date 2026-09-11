// Per-viewer state and mutations for the music pages: the heart on a
// track row, an album page, an artist page (TrackFavourite / AlbumFavourite
// / ArtistFavourite, see prisma/schema.prisma), their playlists (Playlist
// / PlaylistItem: create, rename, delete, add, remove, reorder), and
// loading the built-in "Favourite tracks" list or a playlist as a queue.
//
// The mutation half used to live entirely in app/actions/music-state.ts.
// It moved here (IOS_PLAN.md "A versioned native API", "To share code
// rather than copy") so both the web's server actions and /api/v1's route
// handlers call exactly the same validated logic: each caller resolves its
// own userId (requireMember() for a server action, requireMemberOrResponse()
// for a route) and does its own revalidatePath calls afterwards, since
// revalidation is a Next.js page-cache concern that belongs at the call
// site, not in here — a route handler and a server action revalidate the
// same web paths but for different reasons (one so the app's own next read
// stays fresh isn't needed; it's so the *web* picks up a change made from
// the app).
//
// Every favourite comes in a "set" and a "toggle" form: setXFavourite is
// the idempotent primitive the API's PUT/DELETE routes want (asking for
// the state it's already in is a no-op, not a second write — matters for
// album/artist, whose "on" transition also creates a linked playlist);
// toggleXFavourite, what the web's heart button wants, just reads the
// current state and calls set with the opposite.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getFavouriteTracks, isPlayableCodec } from "@/lib/queries-music";
import { getPlaylistDetail, toQueueTracks } from "@/lib/queries-playlists";
import type { QueueTrack } from "@/lib/player-types";

function assertId(id: number, what: string): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid ${what} id`);
}

/** The artist's own heart plus which of their albums this person has
 *  hearted, for the album tiles' corner hearts. */
export async function getArtistUserState(
  userId: string,
  artistId: number,
): Promise<{ favourite: boolean; favouriteAlbumIds: number[] }> {
  const [row, albums] = await Promise.all([
    prisma.artistFavourite.findUnique({ where: { userId_artistId: { userId, artistId } }, select: { userId: true } }),
    prisma.albumFavourite.findMany({ where: { userId, album: { artistId } }, select: { albumId: true } }),
  ]);
  return { favourite: row !== null, favouriteAlbumIds: albums.map((a) => a.albumId) };
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

// ---------------------------------------------------------------------------
// Track / album / artist favourites
// ---------------------------------------------------------------------------

/** Set (idempotently) whether trackId is favourited. Returns the album id
 *  too, since every caller needs it to revalidate the album page. */
export async function setTrackFavourite(
  userId: string,
  trackId: number,
  favourite: boolean,
): Promise<{ favourite: boolean; albumId: number }> {
  assertId(trackId, "track");
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: { codec: true, albumId: true, album: { select: { owned: true } } },
  });
  // A heart is a promise the rail can play it: refuse what the player
  // can't (DRM'd .m4p, unprobed files, a placeholder album with no files).
  if (!track || !track.album.owned || !isPlayableCodec(track.codec)) throw new Error("track is not playable");

  const existing = await prisma.trackFavourite.findUnique({ where: { userId_trackId: { userId, trackId } } });
  if (favourite && !existing) {
    await prisma.trackFavourite.create({ data: { userId, trackId } });
  } else if (!favourite && existing) {
    await prisma.trackFavourite.delete({ where: { userId_trackId: { userId, trackId } } });
  }
  return { favourite, albumId: track.albumId };
}

export async function toggleTrackFavourite(
  userId: string,
  trackId: number,
): Promise<{ favourite: boolean; albumId: number }> {
  assertId(trackId, "track");
  const existing = await prisma.trackFavourite.findUnique({
    where: { userId_trackId: { userId, trackId } },
    select: { userId: true },
  });
  return setTrackFavourite(userId, trackId, existing === null);
}

/** Every owned, playable track id for an album/artist, ordered album by
 *  album (release year ascending, nulls last, sortTitle as a tiebreak —
 *  same convention as the artist page's own album lists), then within each
 *  album the way its own page plays it (disc, then track number, nulls
 *  last, title as a final tiebreak). Grouping by album first matters for
 *  the artist case: without it, tracks from different albums that happen
 *  to share a disc/track number interleave in whatever order the DB
 *  returns them — the track set a freshly-linked playlist is seeded with. */
async function playableTrackIds(where: Prisma.TrackWhereInput): Promise<number[]> {
  const tracks = await prisma.track.findMany({
    where,
    select: {
      id: true,
      disc: true,
      trackNumber: true,
      title: true,
      codec: true,
      album: { select: { year: true, sortTitle: true } },
    },
  });
  return tracks
    .filter((t) => isPlayableCodec(t.codec))
    .sort((a, b) => {
      if (a.album.year !== b.album.year) {
        if (a.album.year === null) return 1;
        if (b.album.year === null) return -1;
        return a.album.year - b.album.year;
      }
      if (a.album.sortTitle !== b.album.sortTitle) return a.album.sortTitle.localeCompare(b.album.sortTitle);
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

/** Set (idempotently) whether albumId is favourited, creating/removing its
 *  linked playlist exactly as the "on"/"off" transition does. Returns the
 *  artist id too, since every caller needs it to revalidate the artist
 *  page. */
export async function setAlbumFavourite(
  userId: string,
  albumId: number,
  favourite: boolean,
): Promise<{ favourite: boolean; artistId: number }> {
  assertId(albumId, "album");
  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { artistId: true, title: true, artist: { select: { name: true } } },
  });
  if (!album) throw new Error("album not found");

  const existing = await prisma.albumFavourite.findUnique({ where: { userId_albumId: { userId, albumId } } });
  if (favourite && !existing) {
    await prisma.albumFavourite.create({ data: { userId, albumId } });
    const trackIds = await playableTrackIds({ albumId, album: { owned: true } });
    await createLinkedPlaylist(userId, `${album.artist.name} — ${album.title}`, trackIds, { sourceAlbumId: albumId });
  } else if (!favourite && existing) {
    await prisma.$transaction([
      prisma.albumFavourite.delete({ where: { userId_albumId: { userId, albumId } } }),
      prisma.playlist.deleteMany({ where: { userId, sourceAlbumId: albumId } }), // items cascade
    ]);
  }
  return { favourite, artistId: album.artistId };
}

export async function toggleAlbumFavourite(
  userId: string,
  albumId: number,
): Promise<{ favourite: boolean; artistId: number }> {
  assertId(albumId, "album");
  const existing = await prisma.albumFavourite.findUnique({
    where: { userId_albumId: { userId, albumId } },
    select: { userId: true },
  });
  return setAlbumFavourite(userId, albumId, existing === null);
}

/** Set (idempotently) whether artistId is favourited, creating/removing
 *  its linked playlist exactly as the "on"/"off" transition does. */
export async function setArtistFavourite(
  userId: string,
  artistId: number,
  favourite: boolean,
): Promise<{ favourite: boolean }> {
  assertId(artistId, "artist");
  const artist = await prisma.artist.findUnique({ where: { id: artistId }, select: { id: true, name: true } });
  if (!artist) throw new Error("artist not found");

  const existing = await prisma.artistFavourite.findUnique({ where: { userId_artistId: { userId, artistId } } });
  if (favourite && !existing) {
    await prisma.artistFavourite.create({ data: { userId, artistId } });
    const trackIds = await playableTrackIds({ album: { artistId, owned: true } });
    await createLinkedPlaylist(userId, artist.name, trackIds, { sourceArtistId: artistId });
  } else if (!favourite && existing) {
    await prisma.$transaction([
      prisma.artistFavourite.delete({ where: { userId_artistId: { userId, artistId } } }),
      prisma.playlist.deleteMany({ where: { userId, sourceArtistId: artistId } }), // items cascade
    ]);
  }
  return { favourite };
}

export async function toggleArtistFavourite(userId: string, artistId: number): Promise<{ favourite: boolean }> {
  assertId(artistId, "artist");
  const existing = await prisma.artistFavourite.findUnique({
    where: { userId_artistId: { userId, artistId } },
    select: { userId: true },
  });
  return setArtistFavourite(userId, artistId, existing === null);
}

// ---------------------------------------------------------------------------
// Queue loading
// ---------------------------------------------------------------------------

/** The tracks behind a rail row, as queue entries, so Play there needs no
 *  page visit. "favourites" is the built-in list; a number is one of the
 *  person's own playlists. */
export async function loadPlaylistQueue(userId: string, id: "favourites" | number): Promise<QueueTrack[]> {
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

export async function createPlaylist(userId: string, rawName: string): Promise<{ id: number; name: string }> {
  const name = cleanPlaylistName(rawName);
  const created = await prisma.playlist.create({ data: { userId, name }, select: { id: true } });
  return { id: created.id, name };
}

export async function renamePlaylist(
  userId: string,
  playlistId: number,
  rawName: string,
): Promise<{ id: number; name: string }> {
  const name = cleanPlaylistName(rawName);
  const playlist = await ownedPlaylist(userId, playlistId);
  await prisma.playlist.update({ where: { id: playlist.id }, data: { name } });
  return { id: playlist.id, name };
}

export async function deletePlaylist(userId: string, playlistId: number): Promise<void> {
  const playlist = await ownedPlaylist(userId, playlistId);
  await prisma.playlist.delete({ where: { id: playlist.id } }); // items cascade
}

/** Append tracks in the order given. Skips ids already in the playlist,
 *  duplicates within the call, and anything the player can't play (DRM,
 *  unprobed, or an album with no files) — so "Add album" is idempotent
 *  and a heart-able track is always a playlist-able one. Positions stay
 *  dense: new items take max(position)+1 onward. */
export async function addTracksToPlaylist(
  userId: string,
  playlistId: number,
  trackIds: number[],
): Promise<{ added: number; skipped: number }> {
  if (!Array.isArray(trackIds)) throw new Error("invalid track ids");
  if (trackIds.length > PLAYLIST_ADD_MAX) throw new Error(`at most ${PLAYLIST_ADD_MAX} tracks per add`);
  for (const id of trackIds) assertId(id, "track");
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

export async function removePlaylistItem(userId: string, playlistId: number, itemId: number): Promise<void> {
  assertId(itemId, "item");
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
}

/** Move one item to `toPosition` (clamped to the list), shifting the
 *  others. Up/down buttons pass position ∓ 1. `moved` tells the caller
 *  whether anything actually changed, so a no-op (already at that
 *  position) skips revalidation. */
export async function movePlaylistItem(
  userId: string,
  playlistId: number,
  itemId: number,
  toPosition: number,
): Promise<{ moved: boolean }> {
  assertId(itemId, "item");
  if (!Number.isInteger(toPosition)) throw new Error("invalid position");
  const playlist = await ownedPlaylist(userId, playlistId);
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  const from = items.findIndex((it) => it.id === itemId);
  if (from === -1) throw new Error("Track is not in this playlist");
  const to = Math.min(Math.max(toPosition, 0), items.length - 1);
  if (from === to) return { moved: false };
  const ids = items.map((it) => it.id);
  ids.splice(from, 1);
  ids.splice(to, 0, itemId);
  await renumber(playlist.id, ids, new Map(items.map((it) => [it.id, it.position])));
  return { moved: true };
}

/** Replace the whole ordering in one shot — the multi-item drag-and-drop
 *  reorder in PlaylistView (select several rows, drag them as a group)
 *  sends the complete new item-id order rather than one move at a time.
 *  `itemIds` must be exactly the playlist's current item ids, just
 *  reordered; a mismatched set (e.g. a stale drag racing a remove in
 *  another tab) is rejected rather than silently dropping/duplicating
 *  rows. */
export async function reorderPlaylistItems(userId: string, playlistId: number, itemIds: number[]): Promise<void> {
  if (!Array.isArray(itemIds)) throw new Error("invalid item order");
  for (const id of itemIds) assertId(id, "item");
  const playlist = await ownedPlaylist(userId, playlistId);
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    select: { id: true, position: true },
  });
  const current = new Map(items.map((it) => [it.id, it.position]));
  if (itemIds.length !== items.length || itemIds.some((id) => !current.has(id))) {
    throw new Error("invalid item order");
  }
  await renumber(playlist.id, itemIds, current);
}
