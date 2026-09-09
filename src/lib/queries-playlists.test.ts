// Exercises queries-playlists.ts (getUserPlaylists, getPlaylistDetail,
// toQueueTracks) plus the Track/Playlist delete cascades that back
// addTracksToPlaylist/deletePlaylist's assumptions, against a REAL,
// isolated SQLite database — same pattern as queries-music.test.ts, since
// the shaping/ordering here (updatedAt-desc, cover-from-first-item,
// position order, null-duration summing) is exactly the kind of thing
// that's easy to get subtly wrong from reading alone.
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

const { getUserPlaylists, getPlaylistDetail, toQueueTracks } = await import("@/lib/queries-playlists");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
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

async function seedArtist(id: number, name = `Artist ${id}`) {
  return testPrisma.artist.create({
    data: { id, name, sortName: name.toLowerCase() },
  });
}

async function seedAlbum(opts: {
  id: number;
  artistId: number;
  title?: string;
  coverPath?: string | null;
  updatedAt?: Date;
}) {
  const title = opts.title ?? `Album ${opts.id}`;
  return testPrisma.album.create({
    data: {
      id: opts.id,
      artistId: opts.artistId,
      title,
      sortTitle: title.toLowerCase(),
      coverPath: opts.coverPath ?? null,
      updatedAt: opts.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
      folder: `album-${opts.id}`,
    },
  });
}

async function seedTrack(opts: { id: number; albumId: number; title?: string; durationSecs?: number | null }) {
  return testPrisma.track.create({
    data: {
      id: opts.id,
      albumId: opts.albumId,
      title: opts.title ?? `Track ${opts.id}`,
      filePath: `/music/track-${opts.id}.m4a`,
      fileName: `track-${opts.id}.m4a`,
      codec: "alac",
      durationSecs: opts.durationSecs === undefined ? null : opts.durationSecs,
    },
  });
}

async function seedPlaylist(userId: string, name = "My Playlist", updatedAt?: Date) {
  return testPrisma.playlist.create({
    data: { userId, name, ...(updatedAt ? { updatedAt } : {}) },
  });
}

async function seedPlaylistItem(playlistId: number, trackId: number, position: number) {
  return testPrisma.playlistItem.create({ data: { playlistId, trackId, position } });
}

// ---------------------------------------------------------------------------
// getUserPlaylists
// ---------------------------------------------------------------------------

describe("getUserPlaylists", () => {
  it("returns only the signed-in user's own playlists", async () => {
    await seedUser("gup-user-a");
    await seedUser("gup-user-b");
    await seedPlaylist("gup-user-a", "A's list");
    await seedPlaylist("gup-user-b", "B's list");

    const result = await getUserPlaylists("gup-user-a");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("A's list");
  });

  it("orders by updatedAt descending", async () => {
    await seedUser("gup-order");
    const oldest = await seedPlaylist("gup-order", "Oldest", new Date("2026-01-01T00:00:00Z"));
    const newest = await seedPlaylist("gup-order", "Newest", new Date("2026-03-01T00:00:00Z"));
    const middle = await seedPlaylist("gup-order", "Middle", new Date("2026-02-01T00:00:00Z"));

    const result = await getUserPlaylists("gup-order");
    expect(result.map((p) => p.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it("reports trackCount", async () => {
    await seedUser("gup-count");
    const artist = await seedArtist(8001);
    const album = await seedAlbum({ id: 8001, artistId: artist.id });
    const t1 = await seedTrack({ id: 8010, albumId: album.id });
    const t2 = await seedTrack({ id: 8011, albumId: album.id });
    const playlist = await seedPlaylist("gup-count");
    await seedPlaylistItem(playlist.id, t1.id, 0);
    await seedPlaylistItem(playlist.id, t2.id, 1);

    const result = await getUserPlaylists("gup-count");
    expect(result.find((p) => p.id === playlist.id)?.trackCount).toBe(2);
  });

  it("derives coverAlbumId/coverVersion from the first item's album", async () => {
    await seedUser("gup-cover");
    const artist = await seedArtist(8002);
    const coveredAlbum = await seedAlbum({ id: 8002, artistId: artist.id, coverPath: "cover.jpg", updatedAt: new Date("2026-05-01T00:00:00Z") });
    const t1 = await seedTrack({ id: 8020, albumId: coveredAlbum.id });
    const playlist = await seedPlaylist("gup-cover");
    await seedPlaylistItem(playlist.id, t1.id, 0);

    const result = await getUserPlaylists("gup-cover");
    const row = result.find((p) => p.id === playlist.id);
    expect(row?.coverAlbumId).toBe(coveredAlbum.id);
    expect(row?.coverVersion).toBe(new Date("2026-05-01T00:00:00Z").getTime());
  });

  it("coverAlbumId/coverVersion are null when the playlist is empty", async () => {
    await seedUser("gup-empty");
    const playlist = await seedPlaylist("gup-empty");

    const result = await getUserPlaylists("gup-empty");
    const row = result.find((p) => p.id === playlist.id);
    expect(row?.coverAlbumId).toBeNull();
    expect(row?.coverVersion).toBeNull();
  });

  it("coverAlbumId/coverVersion are null when the first item's album has no coverPath", async () => {
    await seedUser("gup-nocover");
    const artist = await seedArtist(8003);
    const bareAlbum = await seedAlbum({ id: 8003, artistId: artist.id, coverPath: null });
    const t1 = await seedTrack({ id: 8030, albumId: bareAlbum.id });
    const playlist = await seedPlaylist("gup-nocover");
    await seedPlaylistItem(playlist.id, t1.id, 0);

    const result = await getUserPlaylists("gup-nocover");
    const row = result.find((p) => p.id === playlist.id);
    expect(row?.coverAlbumId).toBeNull();
    expect(row?.coverVersion).toBeNull();
  });

  it("uses the FIRST item (by position), not just any item", async () => {
    await seedUser("gup-first");
    const artist = await seedArtist(8004);
    const uncoveredFirst = await seedAlbum({ id: 8004, artistId: artist.id, coverPath: null });
    const coveredSecond = await seedAlbum({ id: 8005, artistId: artist.id, coverPath: "cover.jpg" });
    const t1 = await seedTrack({ id: 8040, albumId: uncoveredFirst.id });
    const t2 = await seedTrack({ id: 8041, albumId: coveredSecond.id });
    const playlist = await seedPlaylist("gup-first");
    await seedPlaylistItem(playlist.id, t1.id, 0);
    await seedPlaylistItem(playlist.id, t2.id, 1);

    const result = await getUserPlaylists("gup-first");
    const row = result.find((p) => p.id === playlist.id);
    // First item's album (uncoveredFirst) has no cover, even though the
    // second item's album does.
    expect(row?.coverAlbumId).toBeNull();
    expect(row?.coverVersion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPlaylistDetail
// ---------------------------------------------------------------------------

describe("getPlaylistDetail", () => {
  it("returns null for another user's playlist id", async () => {
    await seedUser("gpd-owner");
    await seedUser("gpd-other");
    const playlist = await seedPlaylist("gpd-owner");

    expect(await getPlaylistDetail("gpd-other", playlist.id)).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    await seedUser("gpd-unknown");
    expect(await getPlaylistDetail("gpd-unknown", 999999)).toBeNull();
  });

  it("returns items in position order with itemId, position, and artist/album fields", async () => {
    await seedUser("gpd-items");
    const artist = await seedArtist(8100, "Detail Artist");
    const album = await seedAlbum({ id: 8100, artistId: artist.id, title: "Detail Album" });
    const t1 = await seedTrack({ id: 8110, albumId: album.id, title: "One" });
    const t2 = await seedTrack({ id: 8111, albumId: album.id, title: "Two" });
    const playlist = await seedPlaylist("gpd-items", "Detail List");
    const item2 = await seedPlaylistItem(playlist.id, t2.id, 0);
    const item1 = await seedPlaylistItem(playlist.id, t1.id, 1);

    const detail = await getPlaylistDetail("gpd-items", playlist.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(playlist.id);
    expect(detail!.name).toBe("Detail List");
    expect(detail!.items.map((i) => i.trackId)).toEqual([t2.id, t1.id]);
    expect(detail!.items[0]).toMatchObject({
      itemId: item2.id,
      position: 0,
      trackId: t2.id,
      title: "Two",
      artist: "Detail Artist",
      albumId: album.id,
      albumTitle: "Detail Album",
    });
    expect(detail!.items[1]).toMatchObject({
      itemId: item1.id,
      position: 1,
      trackId: t1.id,
    });
  });

  it("totalSecs sums durations, treating null durations as 0", async () => {
    await seedUser("gpd-total");
    const artist = await seedArtist(8101);
    const album = await seedAlbum({ id: 8101, artistId: artist.id });
    const t1 = await seedTrack({ id: 8120, albumId: album.id, durationSecs: 120.5 });
    const t2 = await seedTrack({ id: 8121, albumId: album.id, durationSecs: null });
    const t3 = await seedTrack({ id: 8122, albumId: album.id, durationSecs: 59.5 });
    const playlist = await seedPlaylist("gpd-total");
    await seedPlaylistItem(playlist.id, t1.id, 0);
    await seedPlaylistItem(playlist.id, t2.id, 1);
    await seedPlaylistItem(playlist.id, t3.id, 2);

    const detail = await getPlaylistDetail("gpd-total", playlist.id);
    expect(detail!.totalSecs).toBe(180);
  });

  it("createdAt is an ISO string", async () => {
    await seedUser("gpd-created");
    const playlist = await seedPlaylist("gpd-created");

    const detail = await getPlaylistDetail("gpd-created", playlist.id);
    expect(typeof detail!.createdAt).toBe("string");
    expect(new Date(detail!.createdAt).toISOString()).toBe(detail!.createdAt);
  });
});

// ---------------------------------------------------------------------------
// toQueueTracks
// ---------------------------------------------------------------------------

describe("toQueueTracks", () => {
  it("strips itemId/position and keeps exactly the QueueTrack keys", async () => {
    await seedUser("qt-strip");
    const artist = await seedArtist(8200, "QT Artist");
    const album = await seedAlbum({ id: 8200, artistId: artist.id, title: "QT Album" });
    const t1 = await seedTrack({ id: 8210, albumId: album.id, title: "QT Track" });
    const playlist = await seedPlaylist("qt-strip");
    await seedPlaylistItem(playlist.id, t1.id, 0);

    const detail = await getPlaylistDetail("qt-strip", playlist.id);
    const queue = toQueueTracks(detail!.items);

    expect(queue).toHaveLength(1);
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
    expect(queue[0]).not.toHaveProperty("itemId");
    expect(queue[0]).not.toHaveProperty("position");
  });
});

// ---------------------------------------------------------------------------
// Cascades
// ---------------------------------------------------------------------------

describe("cascades", () => {
  it("deleting a Track removes its PlaylistItems", async () => {
    await seedUser("cascade-track");
    const artist = await seedArtist(8300);
    const album = await seedAlbum({ id: 8300, artistId: artist.id });
    const track = await seedTrack({ id: 8310, albumId: album.id });
    const playlist = await seedPlaylist("cascade-track");
    const item = await seedPlaylistItem(playlist.id, track.id, 0);

    await testPrisma.track.delete({ where: { id: track.id } });

    expect(await testPrisma.playlistItem.findUnique({ where: { id: item.id } })).toBeNull();
  });

  it("deleting a Playlist removes its PlaylistItems", async () => {
    await seedUser("cascade-playlist");
    const artist = await seedArtist(8301);
    const album = await seedAlbum({ id: 8301, artistId: artist.id });
    const track = await seedTrack({ id: 8320, albumId: album.id });
    const playlist = await seedPlaylist("cascade-playlist");
    const item = await seedPlaylistItem(playlist.id, track.id, 0);

    await testPrisma.playlist.delete({ where: { id: playlist.id } });

    expect(await testPrisma.playlistItem.findUnique({ where: { id: item.id } })).toBeNull();
  });
});
