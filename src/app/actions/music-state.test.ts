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

const { toggleTrackFavourite, toggleAlbumFavourite, toggleArtistFavourite, loadPlaylistQueue } = await import(
  "@/app/actions/music-state"
);

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

async function seedAlbum(opts: { id: number; artistId: number; title?: string; owned?: boolean }) {
  const title = opts.title ?? `Album ${opts.id}`;
  return testPrisma.album.create({
    data: {
      id: opts.id,
      artistId: opts.artistId,
      title,
      sortTitle: title.toLowerCase(),
      owned: opts.owned ?? true,
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

  it("throws for a numeric id (real playlists not available yet)", async () => {
    await seedSignedInMember("queue-user-numeric");
    await expect(loadPlaylistQueue(42)).rejects.toThrow("playlists are not available yet");
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
