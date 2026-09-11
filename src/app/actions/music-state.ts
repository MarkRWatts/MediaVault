"use server";

// Music actions on the signed-in person's own state: the heart on a track
// row, an album page, an artist page, their playlists (create, rename,
// delete, add, remove, reorder), plus loading the built-in "Favourite
// tracks" list or a playlist as a queue so the rail can play it without a
// page visit. Gated by requireMember() like every other server action —
// favourites and playlists are per person, membership is what vouches the
// person in.
//
// The actual logic lives in src/lib/music-user-state.ts (IOS_PLAN.md "A
// versioned native API", "To share code rather than copy"): every function
// here is just requireMember() + the lib call + the revalidatePath calls
// the pages that render a heart or the rail need, so that /api/v1's route
// handlers can call the same lib functions for the native app and stay in
// lockstep with the web. Every toggle revalidates the pages that render
// the heart AND the root layout, because the rail's pinned "Favourite
// tracks · N" row is rendered there (components/shell/app-shell.tsx reads
// the count per request).

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/require-member";
import * as musicUserState from "@/lib/music-user-state";
import type { QueueTrack } from "@/lib/player-types";

function revalidateFavourites(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/music");
  revalidatePath("/music/favourites");
  revalidatePath("/", "layout");
}

export async function toggleTrackFavourite(trackId: number): Promise<{ favourite: boolean }> {
  const { userId } = await requireMember();
  const result = await musicUserState.toggleTrackFavourite(userId, trackId);
  revalidateFavourites(`/music/album/${result.albumId}`);
  return { favourite: result.favourite };
}

export async function toggleAlbumFavourite(albumId: number): Promise<{ favourite: boolean }> {
  const { userId } = await requireMember();
  const result = await musicUserState.toggleAlbumFavourite(userId, albumId);
  revalidateFavourites(`/music/album/${albumId}`, `/music/artist/${result.artistId}`);
  return { favourite: result.favourite };
}

export async function toggleArtistFavourite(artistId: number): Promise<{ favourite: boolean }> {
  const { userId } = await requireMember();
  const result = await musicUserState.toggleArtistFavourite(userId, artistId);
  revalidateFavourites(`/music/artist/${artistId}`);
  return result;
}

/** The tracks behind a rail row, as queue entries, so Play there needs no
 *  page visit. "favourites" is the built-in list; a number is one of the
 *  person's own playlists. */
export async function loadPlaylistQueue(id: "favourites" | number): Promise<QueueTrack[]> {
  const { userId } = await requireMember();
  return musicUserState.loadPlaylistQueue(userId, id);
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

function revalidatePlaylist(playlistId: number) {
  revalidatePath(`/music/playlist/${playlistId}`);
  revalidatePath("/", "layout"); // the rail's list + counts
}

export async function createPlaylist(rawName: string): Promise<{ id: number }> {
  const { userId } = await requireMember();
  const created = await musicUserState.createPlaylist(userId, rawName);
  revalidatePlaylist(created.id);
  return { id: created.id };
}

export async function renamePlaylist(playlistId: number, rawName: string): Promise<{ name: string }> {
  const { userId } = await requireMember();
  const renamed = await musicUserState.renamePlaylist(userId, playlistId, rawName);
  revalidatePlaylist(renamed.id);
  return { name: renamed.name };
}

export async function deletePlaylist(playlistId: number): Promise<void> {
  const { userId } = await requireMember();
  await musicUserState.deletePlaylist(userId, playlistId);
  revalidatePlaylist(playlistId);
  revalidatePath("/music");
}

export async function addTracksToPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<{ added: number; skipped: number }> {
  const { userId } = await requireMember();
  const result = await musicUserState.addTracksToPlaylist(userId, playlistId, trackIds);
  if (result.added > 0) revalidatePlaylist(playlistId);
  return result;
}

export async function removePlaylistItem(playlistId: number, itemId: number): Promise<void> {
  const { userId } = await requireMember();
  await musicUserState.removePlaylistItem(userId, playlistId, itemId);
  revalidatePlaylist(playlistId);
}

/** Move one item to `toPosition` (clamped to the list), shifting the
 *  others. Up/down buttons pass position ∓ 1. */
export async function movePlaylistItem(playlistId: number, itemId: number, toPosition: number): Promise<void> {
  const { userId } = await requireMember();
  const result = await musicUserState.movePlaylistItem(userId, playlistId, itemId, toPosition);
  if (result.moved) revalidatePlaylist(playlistId);
}

/** Replace the whole ordering in one shot — the multi-item drag-and-drop
 *  reorder in PlaylistView sends the complete new item-id order rather
 *  than one move at a time. */
export async function reorderPlaylistItems(playlistId: number, itemIds: number[]): Promise<void> {
  const { userId } = await requireMember();
  await musicUserState.reorderPlaylistItems(userId, playlistId, itemIds);
  revalidatePlaylist(playlistId);
}
