// Exercises the parts of music-user-state.ts that music-state.test.ts
// doesn't already cover by calling through the server actions: the new
// idempotent setXFavourite variants (PUT/DELETE semantics for
// /api/v1/music/favourites/*) and playlist-mutation ownership refusal
// (the 404-not-500 floor /api/v1's routes rely on). The toggle/create/
// rename/add/move/reorder logic itself is already exercised thoroughly
// via the actions in music-state.test.ts — this file only adds what's
// genuinely new. Same REAL, isolated SQLite database pattern as that
// file, but without the auth/session mocking: every function here takes
// userId directly, so there's no requireMember() in the way.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const {
  setTrackFavourite,
  setAlbumFavourite,
  setArtistFavourite,
  addTracksToPlaylist,
  reorderPlaylistItems,
  removePlaylistItem,
} = await import("@/lib/music-user-state");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

// ---------------------------------------------------------------------------
// Seed helpers — same shapes as music-state.test.ts's.
// ---------------------------------------------------------------------------

async function seedUser(id: string) {
  await testPrisma.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
}

async function seedArtist(id: number, name = `Artist ${id}`) {
  return testPrisma.artist.create({ data: { id, name, sortName: name.toLowerCase() } });
}

async function seedAlbum(opts: { id: number; artistId: number; title?: string }) {
  const title = opts.title ?? `Album ${opts.id}`;
  return testPrisma.album.create({
    data: { id: opts.id, artistId: opts.artistId, title, sortTitle: title.toLowerCase(), owned: true, folder: `album-${opts.id}` },
  });
}

async function seedTrack(opts: { id: number; albumId: number }) {
  return testPrisma.track.create({
    data: {
      id: opts.id,
      albumId: opts.albumId,
      title: `Track ${opts.id}`,
      filePath: `/music/track-${opts.id}.m4a`,
      fileName: `track-${opts.id}.m4a`,
      codec: "alac",
    },
  });
}

async function seedPlaylistWithTracks(userId: string, trackIds: number[]) {
  const playlist = await testPrisma.playlist.create({ data: { userId, name: "My Playlist" } });
  const items = [];
  for (let i = 0; i < trackIds.length; i++) {
    items.push(await testPrisma.playlistItem.create({ data: { playlistId: playlist.id, trackId: trackIds[i], position: i } }));
  }
  return { playlist, items };
}

// ---------------------------------------------------------------------------
// setTrackFavourite / setAlbumFavourite / setArtistFavourite idempotency
// ---------------------------------------------------------------------------

describe("setTrackFavourite", () => {
  it("PUT is a no-op when already favourited; DELETE is a no-op when not", async () => {
    await seedUser("set-track-user");
    const artist = await seedArtist(9001);
    const album = await seedAlbum({ id: 9001, artistId: artist.id });
    const track = await seedTrack({ id: 9001, albumId: album.id });

    const first = await setTrackFavourite("set-track-user", track.id, true);
    expect(first).toEqual({ favourite: true, albumId: album.id });
    const second = await setTrackFavourite("set-track-user", track.id, true); // PUT again
    expect(second).toEqual({ favourite: true, albumId: album.id });
    expect(
      await testPrisma.trackFavourite.findUnique({ where: { userId_trackId: { userId: "set-track-user", trackId: track.id } } }),
    ).not.toBeNull();

    await setTrackFavourite("set-track-user", track.id, false);
    const redundantDelete = await setTrackFavourite("set-track-user", track.id, false); // DELETE again
    expect(redundantDelete).toEqual({ favourite: false, albumId: album.id });
    expect(
      await testPrisma.trackFavourite.findUnique({ where: { userId_trackId: { userId: "set-track-user", trackId: track.id } } }),
    ).toBeNull();
  });
});

describe("setAlbumFavourite", () => {
  it("PUT when already favourited doesn't create a second linked playlist", async () => {
    await seedUser("set-album-user");
    const artist = await seedArtist(9002, "Set Album Artist");
    const album = await seedAlbum({ id: 9002, artistId: artist.id, title: "Set Album" });
    await seedTrack({ id: 9002, albumId: album.id });

    await setAlbumFavourite("set-album-user", album.id, true);
    const afterFirst = await testPrisma.playlist.findMany({ where: { userId: "set-album-user", sourceAlbumId: album.id } });
    expect(afterFirst).toHaveLength(1);

    const second = await setAlbumFavourite("set-album-user", album.id, true); // PUT again
    expect(second).toEqual({ favourite: true, artistId: artist.id });
    const afterSecond = await testPrisma.playlist.findMany({ where: { userId: "set-album-user", sourceAlbumId: album.id } });
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });
});

describe("setArtistFavourite", () => {
  it("DELETE when not favourited is a no-op, not an error", async () => {
    await seedUser("set-artist-user");
    const artist = await seedArtist(9003);

    const result = await setArtistFavourite("set-artist-user", artist.id, false);
    expect(result).toEqual({ favourite: false });
    expect(
      await testPrisma.artistFavourite.findUnique({ where: { userId_artistId: { userId: "set-artist-user", artistId: artist.id } } }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Playlist mutation ownership refusal — the 404-not-500 floor the API's
// routes lean on (apiV1Error maps "Playlist not found" to 404).
// ---------------------------------------------------------------------------

describe("playlist mutation ownership refusal", () => {
  it("addTracksToPlaylist refuses another user's playlist", async () => {
    await seedUser("pl-owner-add");
    await seedUser("pl-other-add");
    const artist = await seedArtist(9010);
    const album = await seedAlbum({ id: 9010, artistId: artist.id });
    const track = await seedTrack({ id: 9010, albumId: album.id });
    const { playlist } = await seedPlaylistWithTracks("pl-owner-add", []);

    await expect(addTracksToPlaylist("pl-other-add", playlist.id, [track.id])).rejects.toThrow("Playlist not found");
  });

  it("reorderPlaylistItems refuses another user's playlist", async () => {
    await seedUser("pl-owner-reorder");
    await seedUser("pl-other-reorder");
    const artist = await seedArtist(9011);
    const album = await seedAlbum({ id: 9011, artistId: artist.id });
    const t1 = await seedTrack({ id: 9011, albumId: album.id });
    const t2 = await seedTrack({ id: 9012, albumId: album.id });
    const { playlist, items } = await seedPlaylistWithTracks("pl-owner-reorder", [t1.id, t2.id]);

    await expect(
      reorderPlaylistItems("pl-other-reorder", playlist.id, [items[1].id, items[0].id]),
    ).rejects.toThrow("Playlist not found");
  });

  it("removePlaylistItem refuses another user's playlist", async () => {
    await seedUser("pl-owner-remove");
    await seedUser("pl-other-remove");
    const artist = await seedArtist(9013);
    const album = await seedAlbum({ id: 9013, artistId: artist.id });
    const track = await seedTrack({ id: 9013, albumId: album.id });
    const { playlist, items } = await seedPlaylistWithTracks("pl-owner-remove", [track.id]);

    await expect(removePlaylistItem("pl-other-remove", playlist.id, items[0].id)).rejects.toThrow("Playlist not found");
    // Refused, not actually removed.
    expect(await testPrisma.playlistItem.findUnique({ where: { id: items[0].id } })).not.toBeNull();
  });
});
