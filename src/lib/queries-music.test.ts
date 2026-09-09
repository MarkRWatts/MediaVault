// Exercises the "Favourites" section of queries-music.ts (isPlayableCodec,
// getFavouriteTracks, countFavouriteTracks, getMusicFavourites) plus
// music-user-state.ts's getAlbumUserState/getArtistUserState, against a
// REAL, isolated SQLite database — same pattern as queries.test.ts/
// require-member.test.ts, since the shaping/filtering/ordering here (newest
// first, DRM/unowned exclusion, coverVersion derivation, per-user cascade)
// is exactly the kind of thing that's easy to get subtly wrong from reading
// alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { isPlayableCodec, getFavouriteTracks, countFavouriteTracks, getMusicFavourites } = await import(
  "@/lib/queries-music"
);
const { getAlbumUserState, getArtistUserState } = await import("@/lib/music-user-state");

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

async function seedArtist(opts: { id: number; name?: string; studioTotal?: number | null }) {
  const name = opts.name ?? `Artist ${opts.id}`;
  return testPrisma.artist.create({
    data: { id: opts.id, name, sortName: name.toLowerCase(), studioTotal: opts.studioTotal ?? null },
  });
}

async function seedAlbum(opts: {
  id: number;
  artistId: number;
  title?: string;
  owned?: boolean;
  kind?: string;
  coverPath?: string | null;
  updatedAt?: Date;
  year?: number | null;
}) {
  const title = opts.title ?? `Album ${opts.id}`;
  return testPrisma.album.create({
    data: {
      id: opts.id,
      artistId: opts.artistId,
      title,
      sortTitle: title.toLowerCase(),
      owned: opts.owned ?? true,
      kind: opts.kind ?? "STUDIO",
      coverPath: opts.coverPath ?? null,
      updatedAt: opts.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
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

async function seedTrackFavourite(userId: string, trackId: number, createdAt: Date) {
  await testPrisma.trackFavourite.create({ data: { userId, trackId, createdAt } });
}

async function seedAlbumFavourite(userId: string, albumId: number, createdAt: Date) {
  await testPrisma.albumFavourite.create({ data: { userId, albumId, createdAt } });
}

async function seedArtistFavourite(userId: string, artistId: number, createdAt: Date) {
  await testPrisma.artistFavourite.create({ data: { userId, artistId, createdAt } });
}

// ---------------------------------------------------------------------------
// isPlayableCodec
// ---------------------------------------------------------------------------

describe("isPlayableCodec", () => {
  it.each(["alac", "aac", "mp3", "flac"])("returns true for %s", (codec) => {
    expect(isPlayableCodec(codec)).toBe(true);
  });

  it.each(["ALAC", "Mp3", "FLAC", "aAc"])("is case-insensitive: %s", (codec) => {
    expect(isPlayableCodec(codec)).toBe(true);
  });

  it("returns false for drm", () => {
    expect(isPlayableCodec("drm")).toBe(false);
  });

  it("returns false for unknown", () => {
    expect(isPlayableCodec("unknown")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isPlayableCodec(null)).toBe(false);
    expect(isPlayableCodec(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFavouriteTracks / countFavouriteTracks
// ---------------------------------------------------------------------------

describe("getFavouriteTracks", () => {
  it("returns newest-first by createdAt, mapped with artist/albumTitle/hasCover/coverVersion", async () => {
    await seedUser("fav-tracks-user");
    const artist = await seedArtist({ id: 4001, name: "Cover Artist" });
    const album = await seedAlbum({
      id: 5001,
      artistId: artist.id,
      title: "Cover Album",
      coverPath: "cover.jpg",
      updatedAt: new Date("2026-02-02T00:00:00Z"),
    });
    const older = await seedTrack({ id: 6001, albumId: album.id, title: "Older Fave" });
    const newer = await seedTrack({ id: 6002, albumId: album.id, title: "Newer Fave" });

    await seedTrackFavourite("fav-tracks-user", older.id, new Date("2026-01-01T00:00:00Z"));
    await seedTrackFavourite("fav-tracks-user", newer.id, new Date("2026-01-05T00:00:00Z"));

    const tracks = await getFavouriteTracks("fav-tracks-user");
    expect(tracks.map((t) => t.trackId)).toEqual([newer.id, older.id]);

    expect(tracks[0]).toEqual({
      trackId: newer.id,
      title: "Newer Fave",
      artist: "Cover Artist",
      albumId: album.id,
      albumTitle: "Cover Album",
      hasCover: true,
      coverVersion: new Date("2026-02-02T00:00:00Z").getTime(),
      durationSecs: null,
      codec: "alac",
      favouritedAt: new Date("2026-01-05T00:00:00Z").toISOString(),
    });
  });

  it("has hasCover false and coverVersion null when the album has no cover art", async () => {
    await seedUser("fav-tracks-nocover-user");
    const artist = await seedArtist({ id: 4002 });
    const album = await seedAlbum({ id: 5002, artistId: artist.id, coverPath: null });
    const track = await seedTrack({ id: 6003, albumId: album.id });
    await seedTrackFavourite("fav-tracks-nocover-user", track.id, new Date());

    const tracks = await getFavouriteTracks("fav-tracks-nocover-user");
    expect(tracks[0].hasCover).toBe(false);
    expect(tracks[0].coverVersion).toBeNull();
  });

  it("excludes DRM and unknown-codec tracks", async () => {
    await seedUser("fav-tracks-drm-user");
    const artist = await seedArtist({ id: 4003 });
    const album = await seedAlbum({ id: 5003, artistId: artist.id });
    const drmTrack = await seedTrack({ id: 6004, albumId: album.id, codec: "drm" });
    const unknownTrack = await seedTrack({ id: 6005, albumId: album.id, codec: "unknown" });
    const nullCodecTrack = await seedTrack({ id: 6006, albumId: album.id, codec: null });
    const playable = await seedTrack({ id: 6007, albumId: album.id, codec: "flac" });

    await seedTrackFavourite("fav-tracks-drm-user", drmTrack.id, new Date());
    await seedTrackFavourite("fav-tracks-drm-user", unknownTrack.id, new Date());
    await seedTrackFavourite("fav-tracks-drm-user", nullCodecTrack.id, new Date());
    await seedTrackFavourite("fav-tracks-drm-user", playable.id, new Date());

    const tracks = await getFavouriteTracks("fav-tracks-drm-user");
    expect(tracks.map((t) => t.trackId)).toEqual([playable.id]);
  });

  it("excludes tracks belonging to an unowned album", async () => {
    await seedUser("fav-tracks-unowned-user");
    const artist = await seedArtist({ id: 4004 });
    const unownedAlbum = await seedAlbum({ id: 5004, artistId: artist.id, owned: false });
    const track = await seedTrack({ id: 6008, albumId: unownedAlbum.id });
    await seedTrackFavourite("fav-tracks-unowned-user", track.id, new Date());

    const tracks = await getFavouriteTracks("fav-tracks-unowned-user");
    expect(tracks).toEqual([]);
  });
});

describe("countFavouriteTracks", () => {
  it("matches the length of getFavouriteTracks' filtered result", async () => {
    await seedUser("count-tracks-user");
    const artist = await seedArtist({ id: 4005 });
    const album = await seedAlbum({ id: 5005, artistId: artist.id });
    const unownedAlbum = await seedAlbum({ id: 5006, artistId: artist.id, owned: false });

    const playable1 = await seedTrack({ id: 6009, albumId: album.id, codec: "mp3" });
    const playable2 = await seedTrack({ id: 6010, albumId: album.id, codec: "aac" });
    const drmTrack = await seedTrack({ id: 6011, albumId: album.id, codec: "drm" });
    const unownedTrack = await seedTrack({ id: 6012, albumId: unownedAlbum.id, codec: "flac" });

    for (const t of [playable1, playable2, drmTrack, unownedTrack]) {
      await seedTrackFavourite("count-tracks-user", t.id, new Date());
    }

    const count = await countFavouriteTracks("count-tracks-user");
    const tracks = await getFavouriteTracks("count-tracks-user");
    expect(count).toBe(tracks.length);
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getMusicFavourites
// ---------------------------------------------------------------------------

describe("getMusicFavourites", () => {
  it("returns favourite artists newest-first, shaped like MusicIndexArtist", async () => {
    await seedUser("fav-artists-user");
    const olderArtist = await seedArtist({ id: 4101, name: "Older Fave Artist", studioTotal: 10 });
    const newerArtist = await seedArtist({ id: 4102, name: "Newer Fave Artist" });
    // ownedStudio/totalStudio computed from albums: 2 studio albums, 1 owned.
    await seedAlbum({ id: 5101, artistId: newerArtist.id, owned: true, kind: "STUDIO" });
    await seedAlbum({ id: 5102, artistId: newerArtist.id, owned: false, kind: "STUDIO" });

    await seedArtistFavourite("fav-artists-user", olderArtist.id, new Date("2026-01-01T00:00:00Z"));
    await seedArtistFavourite("fav-artists-user", newerArtist.id, new Date("2026-01-05T00:00:00Z"));

    const { artists } = await getMusicFavourites("fav-artists-user");
    expect(artists.map((a) => a.id)).toEqual([newerArtist.id, olderArtist.id]);

    const newerShaped = artists[0];
    expect(newerShaped.name).toBe("Newer Fave Artist");
    expect(newerShaped.ownedStudio).toBe(1);
    expect(newerShaped.totalStudio).toBe(2);

    const olderShaped = artists[1];
    // No albums at all -> totalStudio falls back to studioTotal (10).
    expect(olderShaped.ownedStudio).toBe(0);
    expect(olderShaped.totalStudio).toBe(10);
  });

  it("picks coverAlbumId as the earliest owned album with cover art", async () => {
    await seedUser("fav-artists-cover-user");
    const artist = await seedArtist({ id: 4103, name: "Cover Pick Artist" });
    // Earliest year but unowned + no cover -> never a candidate.
    await seedAlbum({ id: 5103, artistId: artist.id, year: 1980, owned: false, coverPath: null });
    // Earlier year, owned, but no cover art -> not a candidate.
    await seedAlbum({
      id: 5104,
      artistId: artist.id,
      year: 1990,
      owned: true,
      coverPath: null,
    });
    // Later year but owned + has cover -> the winning candidate.
    const coveredAlbum = await seedAlbum({
      id: 5105,
      artistId: artist.id,
      year: 2000,
      owned: true,
      coverPath: "cover.jpg",
      updatedAt: new Date("2026-03-03T00:00:00Z"),
    });

    await seedArtistFavourite("fav-artists-cover-user", artist.id, new Date());

    const { artists } = await getMusicFavourites("fav-artists-cover-user");
    expect(artists[0].coverAlbumId).toBe(coveredAlbum.id);
    expect(artists[0].coverVersion).toBe(new Date("2026-03-03T00:00:00Z").getTime());
  });

  it("returns favourite albums newest-first with artistId/artistName", async () => {
    await seedUser("fav-albums-user");
    const artist = await seedArtist({ id: 4104, name: "Album Fave Artist" });
    const olderAlbum = await seedAlbum({ id: 5106, artistId: artist.id, title: "Older Album" });
    const newerAlbum = await seedAlbum({ id: 5107, artistId: artist.id, title: "Newer Album" });

    await seedAlbumFavourite("fav-albums-user", olderAlbum.id, new Date("2026-01-01T00:00:00Z"));
    await seedAlbumFavourite("fav-albums-user", newerAlbum.id, new Date("2026-01-05T00:00:00Z"));

    const { albums } = await getMusicFavourites("fav-albums-user");
    expect(albums.map((a) => a.id)).toEqual([newerAlbum.id, olderAlbum.id]);
    expect(albums[0]).toMatchObject({
      id: newerAlbum.id,
      title: "Newer Album",
      artistId: artist.id,
      artistName: "Album Fave Artist",
    });
  });

  it("trackCount matches countFavouriteTracks for the same user", async () => {
    await seedUser("fav-trackcount-user");
    const artist = await seedArtist({ id: 4105 });
    const album = await seedAlbum({ id: 5108, artistId: artist.id });
    const track = await seedTrack({ id: 6101, albumId: album.id, codec: "mp3" });
    await seedTrackFavourite("fav-trackcount-user", track.id, new Date());

    const { trackCount } = await getMusicFavourites("fav-trackcount-user");
    const expected = await countFavouriteTracks("fav-trackcount-user");
    expect(trackCount).toBe(expected);
    expect(trackCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cascade deletes
// ---------------------------------------------------------------------------

describe("favourite cascades", () => {
  it("deleting a Track removes its TrackFavourite", async () => {
    await seedUser("cascade-track-user");
    const artist = await seedArtist({ id: 4201 });
    const album = await seedAlbum({ id: 5201, artistId: artist.id });
    const track = await seedTrack({ id: 6201, albumId: album.id });
    await seedTrackFavourite("cascade-track-user", track.id, new Date());

    await testPrisma.track.delete({ where: { id: track.id } });

    const row = await testPrisma.trackFavourite.findUnique({
      where: { userId_trackId: { userId: "cascade-track-user", trackId: track.id } },
    });
    expect(row).toBeNull();
  });

  it("deleting an Album removes its AlbumFavourite and, via Track cascade, its track favourites", async () => {
    await seedUser("cascade-album-user");
    const artist = await seedArtist({ id: 4202 });
    const album = await seedAlbum({ id: 5202, artistId: artist.id });
    const track = await seedTrack({ id: 6202, albumId: album.id });
    await seedAlbumFavourite("cascade-album-user", album.id, new Date());
    await seedTrackFavourite("cascade-album-user", track.id, new Date());

    await testPrisma.album.delete({ where: { id: album.id } });

    const albumFav = await testPrisma.albumFavourite.findUnique({
      where: { userId_albumId: { userId: "cascade-album-user", albumId: album.id } },
    });
    expect(albumFav).toBeNull();

    const trackFav = await testPrisma.trackFavourite.findUnique({
      where: { userId_trackId: { userId: "cascade-album-user", trackId: track.id } },
    });
    expect(trackFav).toBeNull();
  });

  it("deleting an Artist removes its ArtistFavourite", async () => {
    await seedUser("cascade-artist-user");
    const artist = await seedArtist({ id: 4203 });
    await seedArtistFavourite("cascade-artist-user", artist.id, new Date());

    await testPrisma.artist.delete({ where: { id: artist.id } });

    const row = await testPrisma.artistFavourite.findUnique({
      where: { userId_artistId: { userId: "cascade-artist-user", artistId: artist.id } },
    });
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAlbumUserState / getArtistUserState (src/lib/music-user-state.ts)
// ---------------------------------------------------------------------------

describe("getArtistUserState", () => {
  it("returns favourite:false when there is no ArtistFavourite row", async () => {
    await seedUser("artist-state-user-off");
    const artist = await seedArtist({ id: 4301 });
    const state = await getArtistUserState("artist-state-user-off", artist.id);
    expect(state).toEqual({ favourite: false, favouriteAlbumIds: [] });
  });

  it("returns favourite:true when a row exists", async () => {
    await seedUser("artist-state-user-on");
    const artist = await seedArtist({ id: 4302 });
    await seedArtistFavourite("artist-state-user-on", artist.id, new Date());
    const state = await getArtistUserState("artist-state-user-on", artist.id);
    expect(state).toEqual({ favourite: true, favouriteAlbumIds: [] });
  });
});

describe("getAlbumUserState", () => {
  it("returns the album heart plus which of its tracks are hearted", async () => {
    await seedUser("album-state-user");
    const artist = await seedArtist({ id: 4303 });
    const album = await seedAlbum({ id: 5301, artistId: artist.id });
    const heartedTrack = await seedTrack({ id: 6301, albumId: album.id });
    const plainTrack = await seedTrack({ id: 6302, albumId: album.id });

    await seedAlbumFavourite("album-state-user", album.id, new Date());
    await seedTrackFavourite("album-state-user", heartedTrack.id, new Date());

    const state = await getAlbumUserState("album-state-user", album.id);
    expect(state.favourite).toBe(true);
    expect(state.favouriteTrackIds).toEqual([heartedTrack.id]);
    expect(state.favouriteTrackIds).not.toContain(plainTrack.id);
  });

  it("returns favourite:false and an empty list when nothing is hearted", async () => {
    await seedUser("album-state-user-empty");
    const artist = await seedArtist({ id: 4304 });
    const album = await seedAlbum({ id: 5302, artistId: artist.id });
    const state = await getAlbumUserState("album-state-user-empty", album.id);
    expect(state).toEqual({ favourite: false, favouriteTrackIds: [] });
  });
});
