// Exercises the music heart toggles (toggleTrackFavourite/toggleAlbumFavourite/
// toggleArtistFavourite) and loadPlaylistQueue("favourites") against a REAL,
// isolated SQLite database — same pattern as require-member.test.ts/
// queries.test.ts, since the interesting part here (playability gating,
// per-user isolation, the on/off toggle round trip) is exactly the kind of
// thing that's easy to get subtly wrong from reading alone.
//
// requireMember() needs BOTH a session (getSession -> { user: { id } }) and
// a Member row for that user (a Household + Member) — see
// src/lib/require-member.ts. next/cache's revalidatePath is mocked so we can
// assert which paths a toggle revalidates without a real Next.js request.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const {
  toggleTrackFavourite,
  toggleAlbumFavourite,
  toggleArtistFavourite,
  loadPlaylistQueue,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTracksToPlaylist,
  removePlaylistItem,
  movePlaylistItem,
  reorderPlaylistItems,
} = await import("@/app/actions/music-state");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterEach(() => {
  getSession.mockReset();
  revalidatePath.mockReset();
});

afterAll(async () => {
  await cleanupDb?.();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(id: string) {
  await testPrisma.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
  });
}

async function seedMember(userId: string) {
  const household = await testPrisma.household.create({
    data: { id: `${userId}-household`, name: `${userId}-household`, slug: `${userId}-household`, createdAt: new Date() },
  });
  await testPrisma.member.create({
    data: { id: `${userId}-member`, householdId: household.id, userId, role: "member", createdAt: new Date() },
  });
}

// A user with both a session and household membership — the common case.
async function seedSignedInMember(userId: string) {
  await seedUser(userId);
  await seedMember(userId);
  getSession.mockResolvedValue({ user: { id: userId } });
}

async function seedArtist(id: number, name = `Artist ${id}`) {
  return testPrisma.artist.create({
    data: { id, name, sortName: name.toLowerCase() },
  });
}

async function seedAlbum(opts: { id: number; artistId: number; title?: string; owned?: boolean; year?: number }) {
  const title = opts.title ?? `Album ${opts.id}`;
  return testPrisma.album.create({
    data: {
      id: opts.id,
      artistId: opts.artistId,
      title,
      sortTitle: title.toLowerCase(),
      owned: opts.owned ?? true,
      year: opts.year ?? null,
      folder: `album-${opts.id}`,
    },
  });
}

async function seedTrack(opts: { id: number; albumId: number; title?: string; codec?: string | null }) {
  return testPrisma.track.create({
    data: {
      id: opts.id,
      albumId: opts.albumId,
      title: opts.title ?? `Track ${opts.id}`,
      filePath: `/music/track-${opts.id}.m4a`,
      fileName: `track-${opts.id}.m4a`,
      codec: opts.codec === undefined ? "alac" : opts.codec,
    },
  });
}

// ---------------------------------------------------------------------------
// toggleTrackFavourite
// ---------------------------------------------------------------------------

describe("toggleTrackFavourite", () => {
  it("creates the favourite row on the first call and returns true", async () => {
    await seedSignedInMember("track-user-1");
    const artist = await seedArtist(1001);
    const album = await seedAlbum({ id: 2001, artistId: artist.id });
    const track = await seedTrack({ id: 3001, albumId: album.id });

    const result = await toggleTrackFavourite(track.id);
    expect(result).toEqual({ favourite: true });

    const row = await testPrisma.trackFavourite.findUnique({
      where: { userId_trackId: { userId: "track-user-1", trackId: track.id } },
    });
    expect(row).not.toBeNull();
  });

  it("deletes the row on a second call and returns false", async () => {
    await seedSignedInMember("track-user-2");
    const artist = await seedArtist(1002);
    const album = await seedAlbum({ id: 2002, artistId: artist.id });
    const track = await seedTrack({ id: 3002, albumId: album.id });

    const first = await toggleTrackFavourite(track.id);
    expect(first).toEqual({ favourite: true });
    const second = await toggleTrackFavourite(track.id);
    expect(second).toEqual({ favourite: false });

    const row = await testPrisma.trackFavourite.findUnique({
      where: { userId_trackId: { userId: "track-user-2", trackId: track.id } },
    });
    expect(row).toBeNull();
  });

  it("throws for a DRM track", async () => {
    await seedSignedInMember("track-user-drm");
    const artist = await seedArtist(1003);
    const album = await seedAlbum({ id: 2003, artistId: artist.id });
    const track = await seedTrack({ id: 3003, albumId: album.id, codec: "drm" });

    await expect(toggleTrackFavourite(track.id)).rejects.toThrow("not playable");
  });

  it("throws for a track whose album is not owned", async () => {
    await seedSignedInMember("track-user-unowned");
    const artist = await seedArtist(1004);
    const album = await seedAlbum({ id: 2004, artistId: artist.id, owned: false });
    const track = await seedTrack({ id: 3004, albumId: album.id });

    await expect(toggleTrackFavourite(track.id)).rejects.toThrow("not playable");
  });

  it("throws for an unknown track id", async () => {
    await seedSignedInMember("track-user-unknown");
    await expect(toggleTrackFavourite(999999)).rejects.toThrow();
  });

  it("throws for a non-integer id", async () => {
    await seedSignedInMember("track-user-noninteger");
    await expect(toggleTrackFavourite(1.5)).rejects.toThrow("invalid track id");
  });

  it("throws when signed out", async () => {
    getSession.mockResolvedValue(null);
    await expect(toggleTrackFavourite(1)).rejects.toThrow("Not signed in");
  });

  it("throws for a user with no Member row", async () => {
    await seedUser("track-user-no-member");
    getSession.mockResolvedValue({ user: { id: "track-user-no-member" } });
    const artist = await seedArtist(1005);
    const album = await seedAlbum({ id: 2005, artistId: artist.id });
    const track = await seedTrack({ id: 3005, albumId: album.id });

    await expect(toggleTrackFavourite(track.id)).rejects.toThrow("You're not part of a household yet.");
  });

  it("revalidates the album path, /music, /music/favourites, and the root layout", async () => {
    await seedSignedInMember("track-user-revalidate");
    const artist = await seedArtist(1006);
    const album = await seedAlbum({ id: 2006, artistId: artist.id });
    const track = await seedTrack({ id: 3006, albumId: album.id });

    await toggleTrackFavourite(track.id);

    expect(revalidatePath).toHaveBeenCalledWith(`/music/album/${album.id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/music");
    expect(revalidatePath).toHaveBeenCalledWith("/music/favourites");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

// ---------------------------------------------------------------------------
// toggleAlbumFavourite
// ---------------------------------------------------------------------------

describe("toggleAlbumFavourite", () => {
  it("round trips on then off", async () => {
    await seedSignedInMember("album-user-1");
    const artist = await seedArtist(1101);
    const album = await seedAlbum({ id: 2101, artistId: artist.id });

    const first = await toggleAlbumFavourite(album.id);
    expect(first).toEqual({ favourite: true });
    const second = await toggleAlbumFavourite(album.id);
    expect(second).toEqual({ favourite: false });
  });

  it("throws for an unknown album id", async () => {
    await seedSignedInMember("album-user-unknown");
    await expect(toggleAlbumFavourite(999999)).rejects.toThrow();
  });

  it("revalidates the artist path", async () => {
    await seedSignedInMember("album-user-revalidate");
    const artist = await seedArtist(1102);
    const album = await seedAlbum({ id: 2102, artistId: artist.id });

    await toggleAlbumFavourite(album.id);

    expect(revalidatePath).toHaveBeenCalledWith(`/music/album/${album.id}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/music/artist/${artist.id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("creates a linked playlist seeded with the album's playable tracks, in disc/track order", async () => {
    await seedSignedInMember("album-user-playlist");
    const artist = await seedArtist(1103, "Playlist Artist");
    const album = await seedAlbum({ id: 2103, artistId: artist.id, title: "Playlist Album" });
    const t2 = await seedTrack({ id: 3103, albumId: album.id, title: "Disc 1 Track 2" });
    await testPrisma.track.update({ where: { id: t2.id }, data: { disc: 1, trackNumber: 2 } });
    const t1 = await seedTrack({ id: 3104, albumId: album.id, title: "Disc 1 Track 1" });
    await testPrisma.track.update({ where: { id: t1.id }, data: { disc: 1, trackNumber: 1 } });
    const t3 = await seedTrack({ id: 3105, albumId: album.id, title: "Disc 2 Track 1", codec: "drm" });
    await testPrisma.track.update({ where: { id: t3.id }, data: { disc: 2, trackNumber: 1 } });

    await toggleAlbumFavourite(album.id);

    const playlist = await testPrisma.playlist.findFirst({ where: { userId: "album-user-playlist" } });
    expect(playlist?.sourceAlbumId).toBe(album.id);
    expect(playlist?.sourceArtistId).toBeNull();
    expect(playlist?.name).toBe("Playlist Artist — Playlist Album");

    const items = await testPrisma.playlistItem.findMany({
      where: { playlistId: playlist!.id },
      orderBy: { position: "asc" },
    });
    // DRM track (t3) is excluded; the two playable tracks come back in
    // disc/track order, not creation order.
    expect(items.map((i) => i.trackId)).toEqual([t1.id, t2.id]);
    expect(items.map((i) => i.position)).toEqual([0, 1]);
  });

  it("deletes the linked playlist and its items when un-favourited", async () => {
    await seedSignedInMember("album-user-unlink");
    const artist = await seedArtist(1104);
    const album = await seedAlbum({ id: 2104, artistId: artist.id });
    await seedTrack({ id: 3106, albumId: album.id });

    await toggleAlbumFavourite(album.id);
    const playlist = await testPrisma.playlist.findFirst({ where: { userId: "album-user-unlink" } });
    expect(playlist).not.toBeNull();

    await toggleAlbumFavourite(album.id);

    expect(await testPrisma.playlist.findUnique({ where: { id: playlist!.id } })).toBeNull();
    expect(await testPrisma.playlistItem.findMany({ where: { playlistId: playlist!.id } })).toEqual([]);
  });

  it("favourites without creating a playlist when the album has no playable tracks", async () => {
    await seedSignedInMember("album-user-empty");
    const artist = await seedArtist(1105);
    const album = await seedAlbum({ id: 2105, artistId: artist.id });
    await seedTrack({ id: 3107, albumId: album.id, codec: "drm" });

    const result = await toggleAlbumFavourite(album.id);

    expect(result).toEqual({ favourite: true });
    expect(await testPrisma.playlist.findFirst({ where: { userId: "album-user-empty" } })).toBeNull();
  });

  it("creates a fresh linked playlist when re-favourited after being unfavourited", async () => {
    await seedSignedInMember("album-user-refavourite");
    const artist = await seedArtist(1106);
    const album = await seedAlbum({ id: 2106, artistId: artist.id });
    await seedTrack({ id: 3108, albumId: album.id });

    await toggleAlbumFavourite(album.id); // on
    const first = await testPrisma.playlist.findFirst({ where: { userId: "album-user-refavourite" } });
    await toggleAlbumFavourite(album.id); // off
    await toggleAlbumFavourite(album.id); // on again

    const second = await testPrisma.playlist.findFirst({ where: { userId: "album-user-refavourite" } });
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });
});

// ---------------------------------------------------------------------------
// toggleArtistFavourite
// ---------------------------------------------------------------------------

describe("toggleArtistFavourite", () => {
  it("round trips on then off", async () => {
    await seedSignedInMember("artist-user-1");
    const artist = await seedArtist(1201);

    const first = await toggleArtistFavourite(artist.id);
    expect(first).toEqual({ favourite: true });
    const second = await toggleArtistFavourite(artist.id);
    expect(second).toEqual({ favourite: false });
  });

  it("throws for an unknown artist id", async () => {
    await seedSignedInMember("artist-user-unknown");
    await expect(toggleArtistFavourite(999999)).rejects.toThrow();
  });

  it("revalidates the artist path", async () => {
    await seedSignedInMember("artist-user-revalidate");
    const artist = await seedArtist(1202);

    await toggleArtistFavourite(artist.id);

    expect(revalidatePath).toHaveBeenCalledWith(`/music/artist/${artist.id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("creates a linked playlist across every owned album, skipping unowned ones", async () => {
    await seedSignedInMember("artist-user-playlist");
    const artist = await seedArtist(1203, "Playlist Artist");
    const owned = await seedAlbum({ id: 2203, artistId: artist.id, title: "Owned Album" });
    const unowned = await seedAlbum({ id: 2204, artistId: artist.id, title: "Unowned Album", owned: false });
    const t1 = await seedTrack({ id: 3203, albumId: owned.id, title: "A" });
    const t2 = await seedTrack({ id: 3204, albumId: owned.id, title: "B" });
    await seedTrack({ id: 3205, albumId: unowned.id, title: "C" });

    await toggleArtistFavourite(artist.id);

    const playlist = await testPrisma.playlist.findFirst({ where: { userId: "artist-user-playlist" } });
    expect(playlist?.sourceArtistId).toBe(artist.id);
    expect(playlist?.sourceAlbumId).toBeNull();
    expect(playlist?.name).toBe("Playlist Artist");

    const items = await testPrisma.playlistItem.findMany({ where: { playlistId: playlist!.id } });
    expect(items.map((i) => i.trackId).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("groups tracks by album (release year order) before disc/track order, not interleaved by matching track numbers", async () => {
    // Regression test: both albums have a disc-1/track-1 and a disc-1/
    // track-2, seeded in an order that would previously interleave them
    // (whatever order the DB happened to return rows in) instead of
    // keeping each album's tracks together.
    await seedSignedInMember("artist-user-album-order");
    const artist = await seedArtist(1206, "Order Artist");
    const later = await seedAlbum({ id: 2206, artistId: artist.id, title: "Later Album", year: 2000 });
    const earlier = await seedAlbum({ id: 2207, artistId: artist.id, title: "Earlier Album", year: 1990 });

    const l1 = await seedTrack({ id: 3210, albumId: later.id, title: "Later 1" });
    await testPrisma.track.update({ where: { id: l1.id }, data: { disc: 1, trackNumber: 1 } });
    const l2 = await seedTrack({ id: 3211, albumId: later.id, title: "Later 2" });
    await testPrisma.track.update({ where: { id: l2.id }, data: { disc: 1, trackNumber: 2 } });
    const e1 = await seedTrack({ id: 3212, albumId: earlier.id, title: "Earlier 1" });
    await testPrisma.track.update({ where: { id: e1.id }, data: { disc: 1, trackNumber: 1 } });
    const e2 = await seedTrack({ id: 3213, albumId: earlier.id, title: "Earlier 2" });
    await testPrisma.track.update({ where: { id: e2.id }, data: { disc: 1, trackNumber: 2 } });

    await toggleArtistFavourite(artist.id);

    const playlist = await testPrisma.playlist.findFirst({ where: { userId: "artist-user-album-order" } });
    const items = await testPrisma.playlistItem.findMany({
      where: { playlistId: playlist!.id },
      orderBy: { position: "asc" },
    });
    // Earlier album (1990) first, both its tracks together, then the
    // later album (2000) — never e1, l1, e2, l2.
    expect(items.map((i) => i.trackId)).toEqual([e1.id, e2.id, l1.id, l2.id]);
  });

  it("deletes the linked playlist and its items when un-favourited", async () => {
    await seedSignedInMember("artist-user-unlink");
    const artist = await seedArtist(1204);
    const album = await seedAlbum({ id: 2205, artistId: artist.id });
    await seedTrack({ id: 3206, albumId: album.id });

    await toggleArtistFavourite(artist.id);
    const playlist = await testPrisma.playlist.findFirst({ where: { userId: "artist-user-unlink" } });
    expect(playlist).not.toBeNull();

    await toggleArtistFavourite(artist.id);

    expect(await testPrisma.playlist.findUnique({ where: { id: playlist!.id } })).toBeNull();
    expect(await testPrisma.playlistItem.findMany({ where: { playlistId: playlist!.id } })).toEqual([]);
  });

  it("favourites without creating a playlist when the artist has no playable tracks", async () => {
    await seedSignedInMember("artist-user-empty");
    const artist = await seedArtist(1205);

    const result = await toggleArtistFavourite(artist.id);

    expect(result).toEqual({ favourite: true });
    expect(await testPrisma.playlist.findFirst({ where: { userId: "artist-user-empty" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadPlaylistQueue("favourites")
// ---------------------------------------------------------------------------

describe('loadPlaylistQueue("favourites")', () => {
  it("returns hearted playable tracks newest-first shaped as QueueTrack", async () => {
    await seedSignedInMember("queue-user-1");
    const artist = await seedArtist(1301, "Queue Artist");
    const album = await seedAlbum({ id: 2301, artistId: artist.id, title: "Queue Album" });
    const trackA = await seedTrack({ id: 3301, albumId: album.id, title: "Track A" });
    const trackB = await seedTrack({ id: 3302, albumId: album.id, title: "Track B" });

    // Favourite A first, then B — B should come back first (newest-first).
    await toggleTrackFavourite(trackA.id);
    await toggleTrackFavourite(trackB.id);

    const queue = await loadPlaylistQueue("favourites");
    expect(queue.map((t) => t.trackId)).toEqual([trackB.id, trackA.id]);

    // Exact QueueTrack field set — no favouritedAt.
    expect(Object.keys(queue[0]).sort()).toEqual(
      [
        "trackId",
        "title",
        "artist",
        "albumId",
        "albumTitle",
        "hasCover",
        "coverVersion",
        "durationSecs",
        "codec",
      ].sort(),
    );
    expect(queue[0]).toEqual({
      trackId: trackB.id,
      title: "Track B",
      artist: "Queue Artist",
      albumId: album.id,
      albumTitle: "Queue Album",
      hasCover: false,
      coverVersion: null,
      durationSecs: null,
      codec: "alac",
    });
  });

  it("throws 'Playlist not found' for an id with no matching playlist", async () => {
    // Playlists exist now (see the "playlists" describe block below); a
    // numeric id that doesn't resolve to one of this user's playlists
    // throws the same "not found" message as an unowned one.
    await seedSignedInMember("queue-user-numeric");
    await expect(loadPlaylistQueue(42)).rejects.toThrow("Playlist not found");
  });

  it("is per-user: another user's toggles never show up in this user's queue", async () => {
    await seedUser("queue-user-a");
    await seedMember("queue-user-a");
    await seedUser("queue-user-b");
    await seedMember("queue-user-b");

    const artist = await seedArtist(1302, "Shared Artist");
    const album = await seedAlbum({ id: 2302, artistId: artist.id, title: "Shared Album" });
    const track = await seedTrack({ id: 3303, albumId: album.id, title: "Shared Track" });

    getSession.mockResolvedValue({ user: { id: "queue-user-b" } });
    await toggleTrackFavourite(track.id);

    getSession.mockResolvedValue({ user: { id: "queue-user-a" } });
    const queueA = await loadPlaylistQueue("favourites");
    expect(queueA).toEqual([]);

    getSession.mockResolvedValue({ user: { id: "queue-user-b" } });
    const queueB = await loadPlaylistQueue("favourites");
    expect(queueB.map((t) => t.trackId)).toEqual([track.id]);
  });
});

// ---------------------------------------------------------------------------
// playlists: createPlaylist / renamePlaylist / deletePlaylist /
// addTracksToPlaylist / removePlaylistItem / movePlaylistItem /
// loadPlaylistQueue(number)
// ---------------------------------------------------------------------------

describe("playlists", () => {
  async function seedPlaylistRow(userId: string, name = "My Playlist") {
    return testPrisma.playlist.create({ data: { userId, name } });
  }

  async function seedPlaylistItem(playlistId: number, trackId: number, position: number) {
    return testPrisma.playlistItem.create({ data: { playlistId, trackId, position } });
  }

  /** A playlist owned by `userId` with `trackIds` appended in order,
   *  positions 0..n-1. Returns the playlist and the created items in
   *  position order. */
  async function seedPlaylistWithTracks(userId: string, trackIds: number[]) {
    const playlist = await seedPlaylistRow(userId);
    const items = [];
    for (let i = 0; i < trackIds.length; i++) {
      items.push(await seedPlaylistItem(playlist.id, trackIds[i], i));
    }
    return { playlist, items };
  }

  async function orderedItems(playlistId: number) {
    return testPrisma.playlistItem.findMany({
      where: { playlistId },
      orderBy: { position: "asc" },
      select: { id: true, trackId: true, position: true },
    });
  }

  // -------------------------------------------------------------------------
  // createPlaylist
  // -------------------------------------------------------------------------

  describe("createPlaylist", () => {
    it("trims the name and returns an id for a row owned by the signed-in user", async () => {
      await seedSignedInMember("pl-create-1");
      const result = await createPlaylist("  Road Trip  ");
      expect(result).toEqual({ id: expect.any(Number) });

      const row = await testPrisma.playlist.findUnique({ where: { id: result.id } });
      expect(row?.name).toBe("Road Trip");
      expect(row?.userId).toBe("pl-create-1");
    });

    it("throws for an empty or whitespace-only name", async () => {
      await seedSignedInMember("pl-create-empty");
      await expect(createPlaylist("")).rejects.toThrow("Playlist name must be");
      await expect(createPlaylist("   ")).rejects.toThrow("Playlist name must be");
    });

    it("throws for a name over 80 characters", async () => {
      await seedSignedInMember("pl-create-long");
      await expect(createPlaylist("x".repeat(81))).rejects.toThrow("Playlist name must be");
    });

    it("throws when signed out", async () => {
      getSession.mockResolvedValue(null);
      await expect(createPlaylist("Anything")).rejects.toThrow("Not signed in");
    });
  });

  // -------------------------------------------------------------------------
  // renamePlaylist
  // -------------------------------------------------------------------------

  describe("renamePlaylist", () => {
    it("renames a playlist owned by the signed-in user", async () => {
      await seedSignedInMember("pl-rename-1");
      const playlist = await seedPlaylistRow("pl-rename-1", "Old Name");

      const result = await renamePlaylist(playlist.id, "  New Name  ");
      expect(result).toEqual({ name: "New Name" });

      const row = await testPrisma.playlist.findUnique({ where: { id: playlist.id } });
      expect(row?.name).toBe("New Name");
    });

    it("throws 'Playlist not found' for another user's playlist", async () => {
      await seedSignedInMember("pl-rename-owner");
      await seedSignedInMember("pl-rename-other");
      const playlist = await seedPlaylistRow("pl-rename-owner");

      getSession.mockResolvedValue({ user: { id: "pl-rename-other" } });
      await expect(renamePlaylist(playlist.id, "Hijacked")).rejects.toThrow("Playlist not found");
    });

    it("throws 'Playlist not found' for an unknown id", async () => {
      await seedSignedInMember("pl-rename-unknown");
      await expect(renamePlaylist(999999, "Whatever")).rejects.toThrow("Playlist not found");
    });

    it("throws for an invalid name", async () => {
      await seedSignedInMember("pl-rename-invalid");
      const playlist = await seedPlaylistRow("pl-rename-invalid");
      await expect(renamePlaylist(playlist.id, "")).rejects.toThrow("Playlist name must be");
      await expect(renamePlaylist(playlist.id, "x".repeat(81))).rejects.toThrow("Playlist name must be");
    });
  });

  // -------------------------------------------------------------------------
  // deletePlaylist
  // -------------------------------------------------------------------------

  describe("deletePlaylist", () => {
    it("removes the playlist and cascades its items", async () => {
      await seedSignedInMember("pl-delete-1");
      const artist = await seedArtist(5001);
      const album = await seedAlbum({ id: 6001, artistId: artist.id });
      const track = await seedTrack({ id: 7001, albumId: album.id });
      const { playlist } = await seedPlaylistWithTracks("pl-delete-1", [track.id]);

      await deletePlaylist(playlist.id);

      expect(await testPrisma.playlist.findUnique({ where: { id: playlist.id } })).toBeNull();
      expect(await testPrisma.playlistItem.findMany({ where: { playlistId: playlist.id } })).toEqual([]);
    });

    it("throws 'Playlist not found' for another user's playlist", async () => {
      await seedSignedInMember("pl-delete-owner");
      await seedSignedInMember("pl-delete-other");
      const playlist = await seedPlaylistRow("pl-delete-owner");

      getSession.mockResolvedValue({ user: { id: "pl-delete-other" } });
      await expect(deletePlaylist(playlist.id)).rejects.toThrow("Playlist not found");

      expect(await testPrisma.playlist.findUnique({ where: { id: playlist.id } })).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // addTracksToPlaylist
  // -------------------------------------------------------------------------

  describe("addTracksToPlaylist", () => {
    it("appends tracks in the given order with dense positions 0..n-1", async () => {
      await seedSignedInMember("pl-add-order");
      const artist = await seedArtist(5010);
      const album = await seedAlbum({ id: 6010, artistId: artist.id });
      const t1 = await seedTrack({ id: 7010, albumId: album.id });
      const t2 = await seedTrack({ id: 7011, albumId: album.id });
      const t3 = await seedTrack({ id: 7012, albumId: album.id });
      const playlist = await seedPlaylistRow("pl-add-order");

      const result = await addTracksToPlaylist(playlist.id, [t3.id, t1.id, t2.id]);
      expect(result).toEqual({ added: 3, skipped: 0 });

      const items = await orderedItems(playlist.id);
      expect(items.map((i) => i.trackId)).toEqual([t3.id, t1.id, t2.id]);
      expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    });

    it("a second call with overlapping ids skips the ones already present", async () => {
      await seedSignedInMember("pl-add-overlap");
      const artist = await seedArtist(5011);
      const album = await seedAlbum({ id: 6011, artistId: artist.id });
      const t1 = await seedTrack({ id: 7020, albumId: album.id });
      const t2 = await seedTrack({ id: 7021, albumId: album.id });
      const t3 = await seedTrack({ id: 7022, albumId: album.id });
      const playlist = await seedPlaylistRow("pl-add-overlap");

      const first = await addTracksToPlaylist(playlist.id, [t1.id, t2.id]);
      expect(first).toEqual({ added: 2, skipped: 0 });

      const second = await addTracksToPlaylist(playlist.id, [t1.id, t3.id]);
      expect(second).toEqual({ added: 1, skipped: 1 });

      const items = await orderedItems(playlist.id);
      expect(items.map((i) => i.trackId)).toEqual([t1.id, t2.id, t3.id]);
      expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    });

    it("duplicates within one call are added once", async () => {
      await seedSignedInMember("pl-add-dup");
      const artist = await seedArtist(5012);
      const album = await seedAlbum({ id: 6012, artistId: artist.id });
      const t1 = await seedTrack({ id: 7030, albumId: album.id });
      const t2 = await seedTrack({ id: 7031, albumId: album.id });
      const playlist = await seedPlaylistRow("pl-add-dup");

      const result = await addTracksToPlaylist(playlist.id, [t1.id, t1.id, t2.id]);
      expect(result).toEqual({ added: 2, skipped: 1 });

      const items = await orderedItems(playlist.id);
      expect(items.map((i) => i.trackId)).toEqual([t1.id, t2.id]);
    });

    it("skips DRM, unknown-codec, and unowned-album tracks", async () => {
      await seedSignedInMember("pl-add-unplayable");
      const artist = await seedArtist(5013);
      const album = await seedAlbum({ id: 6013, artistId: artist.id });
      const unownedAlbum = await seedAlbum({ id: 6014, artistId: artist.id, owned: false });
      const drmTrack = await seedTrack({ id: 7040, albumId: album.id, codec: "drm" });
      const unknownCodecTrack = await seedTrack({ id: 7041, albumId: album.id, codec: "unknown" });
      const unownedTrack = await seedTrack({ id: 7042, albumId: unownedAlbum.id });
      const playlist = await seedPlaylistRow("pl-add-unplayable");

      const result = await addTracksToPlaylist(playlist.id, [drmTrack.id, unknownCodecTrack.id, unownedTrack.id]);
      expect(result).toEqual({ added: 0, skipped: 3 });
      expect(await orderedItems(playlist.id)).toEqual([]);
    });

    it("skips unknown track ids instead of throwing", async () => {
      await seedSignedInMember("pl-add-unknown-id");
      const artist = await seedArtist(5014);
      const album = await seedAlbum({ id: 6015, artistId: artist.id });
      const t1 = await seedTrack({ id: 7050, albumId: album.id });
      const playlist = await seedPlaylistRow("pl-add-unknown-id");

      const result = await addTracksToPlaylist(playlist.id, [t1.id, 999999]);
      expect(result).toEqual({ added: 1, skipped: 1 });
    });

    it("throws for more than 500 ids", async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
      await expect(addTracksToPlaylist(1, tooMany)).rejects.toThrow("at most 500 tracks");
    });

    it("returns {added:0, skipped:0} for an empty array without touching the DB", async () => {
      await seedSignedInMember("pl-add-empty");
      const playlist = await seedPlaylistRow("pl-add-empty");
      const before = await testPrisma.playlist.findUnique({ where: { id: playlist.id } });

      const result = await addTracksToPlaylist(playlist.id, []);
      expect(result).toEqual({ added: 0, skipped: 0 });

      const after = await testPrisma.playlist.findUnique({ where: { id: playlist.id } });
      expect(after?.updatedAt).toEqual(before?.updatedAt);
      expect(await orderedItems(playlist.id)).toEqual([]);
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("bumps Playlist.updatedAt and revalidates the playlist page and root layout", async () => {
      await seedSignedInMember("pl-add-revalidate");
      const artist = await seedArtist(5015);
      const album = await seedAlbum({ id: 6016, artistId: artist.id });
      const t1 = await seedTrack({ id: 7060, albumId: album.id });
      const playlist = await seedPlaylistRow("pl-add-revalidate");
      const before = await testPrisma.playlist.findUnique({ where: { id: playlist.id } });

      await new Promise((resolve) => setTimeout(resolve, 5));
      await addTracksToPlaylist(playlist.id, [t1.id]);

      const after = await testPrisma.playlist.findUnique({ where: { id: playlist.id } });
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());

      expect(revalidatePath).toHaveBeenCalledWith(`/music/playlist/${playlist.id}`);
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    });
  });

  /** A playlist with 4 fresh tracks in position order — shared by
   *  movePlaylistItem's and reorderPlaylistItems' tests. */
  async function seedFourItemPlaylist(userId: string, base: number) {
    const artist = await seedArtist(base);
    const album = await seedAlbum({ id: base + 1, artistId: artist.id });
    const tracks = [];
    for (let i = 0; i < 4; i++) {
      tracks.push(await seedTrack({ id: base + 10 + i, albumId: album.id }));
    }
    const { playlist, items } = await seedPlaylistWithTracks(
      userId,
      tracks.map((t) => t.id),
    );
    return { playlist, items, tracks };
  }

  // -------------------------------------------------------------------------
  // movePlaylistItem
  // -------------------------------------------------------------------------

  describe("movePlaylistItem", () => {
    it("moves an item down", async () => {
      await seedSignedInMember("pl-move-down");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-down", 5100);

      await movePlaylistItem(playlist.id, items[0].id, 1);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[1].id, tracks[0].id, tracks[2].id, tracks[3].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("moves an item up", async () => {
      await seedSignedInMember("pl-move-up");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-up", 5110);

      await movePlaylistItem(playlist.id, items[2].id, 1);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[0].id, tracks[2].id, tracks[1].id, tracks[3].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("moves an item to the front", async () => {
      await seedSignedInMember("pl-move-front");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-front", 5120);

      await movePlaylistItem(playlist.id, items[3].id, 0);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[3].id, tracks[0].id, tracks[1].id, tracks[2].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("moves an item to the end", async () => {
      await seedSignedInMember("pl-move-end");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-end", 5130);

      await movePlaylistItem(playlist.id, items[0].id, 3);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[1].id, tracks[2].id, tracks[3].id, tracks[0].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("clamps a negative target position to the front", async () => {
      await seedSignedInMember("pl-move-clamp-neg");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-clamp-neg", 5140);

      await movePlaylistItem(playlist.id, items[3].id, -50);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[3].id, tracks[0].id, tracks[1].id, tracks[2].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("clamps an out-of-range target position to the end", async () => {
      await seedSignedInMember("pl-move-clamp-pos");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-clamp-pos", 5150);

      await movePlaylistItem(playlist.id, items[0].id, 999);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[1].id, tracks[2].id, tracks[3].id, tracks[0].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("is a no-op when moved to its own position", async () => {
      await seedSignedInMember("pl-move-noop");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-move-noop", 5160);

      await movePlaylistItem(playlist.id, items[2].id, 2);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual(tracks.map((t) => t.id));
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("throws for an item id belonging to another playlist", async () => {
      await seedSignedInMember("pl-move-cross");
      const { playlist: playlistA } = await seedFourItemPlaylist("pl-move-cross", 5170);
      const { items: itemsB } = await seedFourItemPlaylist("pl-move-cross", 5180);

      await expect(movePlaylistItem(playlistA.id, itemsB[0].id, 0)).rejects.toThrow(
        "Track is not in this playlist",
      );
    });
  });

  // -------------------------------------------------------------------------
  // reorderPlaylistItems
  // -------------------------------------------------------------------------

  describe("reorderPlaylistItems", () => {
    it("applies an arbitrary full reorder (e.g. a multi-item drag) in one call", async () => {
      await seedSignedInMember("pl-reorder-1");
      const { playlist, items, tracks } = await seedFourItemPlaylist("pl-reorder-1", 5400);

      // Drag items[1] and items[3] (a non-contiguous multi-selection) to
      // the front, in their original relative order.
      await reorderPlaylistItems(playlist.id, [items[1].id, items[3].id, items[0].id, items[2].id]);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([tracks[1].id, tracks[3].id, tracks[0].id, tracks[2].id]);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    });

    it("throws when the id set doesn't exactly match the playlist's current items", async () => {
      await seedSignedInMember("pl-reorder-mismatch");
      const { playlist, items } = await seedFourItemPlaylist("pl-reorder-mismatch", 5420);

      // Missing one id.
      await expect(
        reorderPlaylistItems(playlist.id, [items[0].id, items[1].id, items[2].id]),
      ).rejects.toThrow("invalid item order");
      // A foreign id mixed in.
      await expect(
        reorderPlaylistItems(playlist.id, [items[0].id, items[1].id, items[2].id, 999999]),
      ).rejects.toThrow("invalid item order");
    });

    it("throws 'Playlist not found' for another user's playlist", async () => {
      await seedSignedInMember("pl-reorder-owner-a");
      const { playlist, items } = await seedFourItemPlaylist("pl-reorder-owner-a", 5440);

      await seedSignedInMember("pl-reorder-owner-b");
      await expect(
        reorderPlaylistItems(playlist.id, items.map((i) => i.id)),
      ).rejects.toThrow("Playlist not found");
    });
  });

  // -------------------------------------------------------------------------
  // removePlaylistItem
  // -------------------------------------------------------------------------

  describe("removePlaylistItem", () => {
    it("removes the item and closes the gap", async () => {
      await seedSignedInMember("pl-remove-1");
      const artist = await seedArtist(5200);
      const album = await seedAlbum({ id: 5201, artistId: artist.id });
      const t1 = await seedTrack({ id: 5210, albumId: album.id });
      const t2 = await seedTrack({ id: 5211, albumId: album.id });
      const t3 = await seedTrack({ id: 5212, albumId: album.id });
      const { playlist, items } = await seedPlaylistWithTracks("pl-remove-1", [t1.id, t2.id, t3.id]);

      await removePlaylistItem(playlist.id, items[1].id);

      const after = await orderedItems(playlist.id);
      expect(after.map((i) => i.trackId)).toEqual([t1.id, t3.id]);
      expect(after.map((i) => i.position)).toEqual([0, 1]);
    });

    it("throws for an item that is not in the playlist", async () => {
      await seedSignedInMember("pl-remove-wrong");
      const artist = await seedArtist(5220);
      const album = await seedAlbum({ id: 5221, artistId: artist.id });
      const t1 = await seedTrack({ id: 5230, albumId: album.id });
      const { playlist: playlistA } = await seedPlaylistWithTracks("pl-remove-wrong", [t1.id]);
      const playlistB = await seedPlaylistRow("pl-remove-wrong", "Other");

      await expect(removePlaylistItem(playlistB.id, 999999)).rejects.toThrow("Track is not in this playlist");
      // Also: an item id that belongs to a different one of this user's own playlists.
      const itemsA = await orderedItems(playlistA.id);
      await expect(removePlaylistItem(playlistB.id, itemsA[0].id)).rejects.toThrow(
        "Track is not in this playlist",
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadPlaylistQueue(<id>)
  // -------------------------------------------------------------------------

  describe("loadPlaylistQueue(<playlist id>)", () => {
    it("returns QueueTracks in position order with the exact QueueTrack field set", async () => {
      await seedSignedInMember("pl-queue-1");
      const artist = await seedArtist(5300, "Queue Playlist Artist");
      const album = await seedAlbum({ id: 5301, artistId: artist.id, title: "Queue Playlist Album" });
      const t1 = await seedTrack({ id: 5310, albumId: album.id, title: "First" });
      const t2 = await seedTrack({ id: 5311, albumId: album.id, title: "Second" });
      const { playlist } = await seedPlaylistWithTracks("pl-queue-1", [t2.id, t1.id]);

      const queue = await loadPlaylistQueue(playlist.id);
      expect(queue.map((t) => t.trackId)).toEqual([t2.id, t1.id]);
      expect(Object.keys(queue[0]).sort()).toEqual(
        [
          "trackId",
          "title",
          "artist",
          "albumId",
          "albumTitle",
          "hasCover",
          "coverVersion",
          "durationSecs",
          "codec",
        ].sort(),
      );
      expect(queue[0]).toEqual({
        trackId: t2.id,
        title: "Second",
        artist: "Queue Playlist Artist",
        albumId: album.id,
        albumTitle: "Queue Playlist Album",
        hasCover: false,
        coverVersion: null,
        durationSecs: null,
        codec: "alac",
      });
    });

    it("throws 'Playlist not found' for another user's playlist id", async () => {
      await seedSignedInMember("pl-queue-owner");
      await seedSignedInMember("pl-queue-other");
      const playlist = await seedPlaylistRow("pl-queue-owner");

      getSession.mockResolvedValue({ user: { id: "pl-queue-other" } });
      await expect(loadPlaylistQueue(playlist.id)).rejects.toThrow("Playlist not found");
    });

    it("throws for a non-integer id", async () => {
      await seedSignedInMember("pl-queue-noninteger");
      await expect(loadPlaylistQueue(1.5)).rejects.toThrow("invalid playlist id");
    });
  });
});
