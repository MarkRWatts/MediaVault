// Data access for a person's playlists (Playlist / PlaylistItem, see
// prisma/schema.prisma) — the rail's list on every page and the
// /music/playlist/[id] page. Server-only, same style as queries-music.ts.
// Every query is scoped by userId: a playlist id from another person's
// account simply doesn't exist here.

import { prisma } from "@/lib/db";
import type { QueueTrack } from "@/lib/player-types";

export interface PlaylistSummary {
  id: number;
  name: string;
  trackCount: number;
  /** The first item's album, for the row's thumbnail; null when empty or
   *  that album has no art. */
  coverAlbumId: number | null;
  coverVersion: number | null;
}

/** One row of a playlist: a ready-made queue entry plus what the page
 *  needs to remove/reorder it. */
export interface PlaylistItemView extends QueueTrack {
  itemId: number;
  position: number;
}

export interface PlaylistDetail {
  id: number;
  name: string;
  createdAt: string; // ISO
  items: PlaylistItemView[];
  totalSecs: number;
}

/** Most recently touched first — adding to or renaming a playlist bumps
 *  it to the top of the rail, the way a "recent" list behaves. */
export async function getUserPlaylists(userId: string): Promise<PlaylistSummary[]> {
  const rows = await prisma.playlist.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      _count: { select: { items: true } },
      items: {
        orderBy: { position: "asc" },
        take: 1,
        select: { track: { select: { album: { select: { id: true, coverPath: true, updatedAt: true } } } } },
      },
    },
  });
  return rows.map((p) => {
    const album = p.items[0]?.track.album;
    const hasCover = album?.coverPath != null;
    return {
      id: p.id,
      name: p.name,
      trackCount: p._count.items,
      coverAlbumId: hasCover ? album.id : null,
      coverVersion: hasCover ? album.updatedAt.getTime() : null,
    };
  });
}

export async function getPlaylistDetail(userId: string, id: number): Promise<PlaylistDetail | null> {
  const playlist = await prisma.playlist.findFirst({
    where: { id, userId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      items: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          track: {
            select: {
              id: true,
              title: true,
              codec: true,
              durationSecs: true,
              album: {
                select: { id: true, title: true, coverPath: true, updatedAt: true, artist: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!playlist) return null;

  const items: PlaylistItemView[] = playlist.items.map((it) => ({
    itemId: it.id,
    position: it.position,
    trackId: it.track.id,
    title: it.track.title,
    artist: it.track.album.artist.name,
    albumId: it.track.album.id,
    albumTitle: it.track.album.title,
    hasCover: it.track.album.coverPath != null,
    coverVersion: it.track.album.coverPath != null ? it.track.album.updatedAt.getTime() : null,
    durationSecs: it.track.durationSecs,
    codec: it.track.codec,
  }));

  return {
    id: playlist.id,
    name: playlist.name,
    createdAt: playlist.createdAt.toISOString(),
    items,
    totalSecs: items.reduce((n, t) => n + (t.durationSecs ?? 0), 0),
  };
}

/** Strip the page-only fields so the engine gets plain QueueTracks. */
export function toQueueTracks(items: PlaylistItemView[]): QueueTrack[] {
  return items.map((t) => ({
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
