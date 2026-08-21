// Data access + shaping for the music UI. Server-only (imports the Prisma
// client directly — every caller is a Server Component), mirrors the style
// of queries.ts. Contract driven by SPEC-MUSIC.md "Queries" — Worker D's UI
// code is written against these exact exported types.

import { prisma } from "@/lib/db";
import { MUSIC_REPORT_MIN_OWNED, MUSIC_REPORT_MIN_PCT } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Shared sort helpers
// ---------------------------------------------------------------------------

// Ascending by year, nulls last — used for both the studio release-order grid
// and the missing-albums report (an album with an unknown year still needs a
// deterministic place at the end of the list).
function byYearAsc<T extends { year: number | null }>(a: T, b: T): number {
  if (a.year === null && b.year === null) return 0;
  if (a.year === null) return 1;
  if (b.year === null) return -1;
  return a.year - b.year;
}

// Artist index/report ordering: sortName ascending, but the Compilations
// various=true pseudo-artist always sorts last regardless of name.
function byArtistOrder<T extends { various: boolean; sortName: string }>(a: T, b: T): number {
  if (a.various !== b.various) return a.various ? 1 : -1;
  return a.sortName.localeCompare(b.sortName);
}

// The artist grid's square cover: the earliest-year owned album that has a
// cached cover image. Missing albums and owned albums with no cover art yet
// (enrichment hasn't run, or CAA/iTunes had nothing) are never picked.
function pickCoverAlbumId(
  albums: { id: number; year: number | null; owned: boolean; coverPath: string | null }[],
): number | null {
  const candidates = albums.filter((a) => a.owned && a.coverPath != null);
  if (candidates.length === 0) return null;
  return candidates.slice().sort(byYearAsc)[0].id;
}

function losslessPct(tracksTotal: number, tracksLossless: number): number {
  return tracksTotal > 0 ? Math.round((tracksLossless / tracksTotal) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Music index ("/music")
// ---------------------------------------------------------------------------

export interface MusicIndexArtist {
  id: number;
  name: string;
  various: boolean;
  ownedStudio: number;
  totalStudio: number;
  coverAlbumId: number | null;
}

export interface MusicIndexData {
  totals: { artists: number; albumsOwned: number; tracks: number; losslessPct: number };
  artists: MusicIndexArtist[]; // sorted by sortName, various=true last
}

export async function getMusicIndex(): Promise<MusicIndexData> {
  const [artists, albumsOwned, tracksTotal, tracksLossless] = await Promise.all([
    prisma.artist.findMany({
      select: {
        id: true,
        name: true,
        sortName: true,
        various: true,
        albums: { select: { id: true, kind: true, owned: true, year: true, coverPath: true } },
      },
    }),
    prisma.album.count({ where: { owned: true } }),
    prisma.track.count(),
    prisma.track.count({ where: { lossless: true } }),
  ]);

  const shaped: MusicIndexArtist[] = artists
    .slice()
    .sort(byArtistOrder)
    .map((a) => {
      const studioAlbums = a.albums.filter((al) => al.kind === "STUDIO");
      return {
        id: a.id,
        name: a.name,
        various: a.various,
        ownedStudio: studioAlbums.filter((al) => al.owned).length,
        totalStudio: studioAlbums.length,
        coverAlbumId: pickCoverAlbumId(a.albums),
      };
    });

  return {
    totals: {
      artists: artists.length,
      albumsOwned,
      tracks: tracksTotal,
      losslessPct: losslessPct(tracksTotal, tracksLossless),
    },
    artists: shaped,
  };
}

// ---------------------------------------------------------------------------
// Artist detail ("/music/artist/[id]")
// ---------------------------------------------------------------------------

export interface ArtistCatalogueAlbum {
  id: number;
  title: string;
  year: number | null;
  owned: boolean;
  hasCover: boolean;
  trackCount: number;
  trackTotal: number | null;
}

export interface ArtistShelfAlbum extends ArtistCatalogueAlbum {
  kind: string;
}

export interface ArtistDetail {
  artist: { id: number; name: string; disambiguation: string | null; various: boolean };
  studio: ArtistCatalogueAlbum[]; // full back-catalogue, release (year) order, nulls last
  shelf: ArtistShelfAlbum[]; // owned non-studio albums, by year
  stats: { owned: number; total: number; pct: number; yearMin: number | null; yearMax: number | null };
}

export async function getArtistDetail(id: number): Promise<ArtistDetail | null> {
  const artist = await prisma.artist.findUnique({
    where: { id },
    include: {
      albums: { include: { _count: { select: { tracks: true } } } },
    },
  });
  if (!artist) return null;

  const toCatalogueAlbum = (a: (typeof artist.albums)[number]): ArtistCatalogueAlbum => ({
    id: a.id,
    title: a.title,
    year: a.year,
    owned: a.owned,
    hasCover: a.coverPath != null,
    trackCount: a._count.tracks,
    trackTotal: a.trackTotal,
  });

  const studio: ArtistCatalogueAlbum[] = artist.albums
    .filter((a) => a.kind === "STUDIO")
    .map(toCatalogueAlbum)
    .sort(byYearAsc);

  const shelf: ArtistShelfAlbum[] = artist.albums
    .filter((a) => a.owned && a.kind !== "STUDIO")
    .map((a) => ({ ...toCatalogueAlbum(a), kind: a.kind }))
    .sort(byYearAsc);

  const ownedStudio = studio.filter((a) => a.owned).length;
  const totalStudio = studio.length;
  const studioYears = studio.map((a) => a.year).filter((y): y is number => y !== null);

  return {
    artist: {
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation,
      various: artist.various,
    },
    studio,
    shelf,
    stats: {
      owned: ownedStudio,
      total: totalStudio,
      pct: totalStudio > 0 ? Math.round((ownedStudio / totalStudio) * 100) : 0,
      yearMin: studioYears.length > 0 ? Math.min(...studioYears) : null,
      yearMax: studioYears.length > 0 ? Math.max(...studioYears) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Album detail ("/music/album/[id]")
// ---------------------------------------------------------------------------

export interface AlbumTrackView {
  id: number;
  trackNumber: number | null;
  title: string;
  codec: string | null;
  lossless: boolean;
  durationSecs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  sizeBytes: number | null; // BigInt from the DB, serialized to number for the UI layer
}

export interface AlbumDiscView {
  disc: number;
  tracks: AlbumTrackView[];
}

export interface AlbumDetail {
  id: number;
  title: string;
  year: number | null;
  kind: string;
  owned: boolean;
  hasCover: boolean;
  trackTotal: number | null;
  artist: { id: number; name: string; various: boolean };
  discs: AlbumDiscView[]; // ordered by disc number, tracks by trackNumber (nulls last)
}

export async function getAlbumDetail(id: number): Promise<AlbumDetail | null> {
  const album = await prisma.album.findUnique({
    where: { id },
    include: {
      artist: { select: { id: true, name: true, various: true } },
      tracks: true,
    },
  });
  if (!album) return null;

  const byDisc = new Map<number, AlbumTrackView[]>();
  for (const t of album.tracks) {
    const track: AlbumTrackView = {
      id: t.id,
      trackNumber: t.trackNumber,
      title: t.title,
      codec: t.codec,
      lossless: t.lossless,
      durationSecs: t.durationSecs,
      sampleRate: t.sampleRate,
      bitDepth: t.bitDepth,
      // Client Component is plain data: BigInt sizeBytes is converted to a
      // number here, same convention as queries.ts (movie file sizes).
      sizeBytes: t.sizeBytes === null ? null : Number(t.sizeBytes),
    };
    const arr = byDisc.get(t.disc);
    if (arr) arr.push(track);
    else byDisc.set(t.disc, [track]);
  }

  const discs: AlbumDiscView[] = Array.from(byDisc.entries())
    .sort(([discA], [discB]) => discA - discB)
    .map(([disc, tracks]) => ({
      disc,
      tracks: tracks.sort((a, b) => {
        if (a.trackNumber === null && b.trackNumber === null) return a.title.localeCompare(b.title);
        if (a.trackNumber === null) return 1;
        if (b.trackNumber === null) return -1;
        return a.trackNumber - b.trackNumber;
      }),
    }));

  return {
    id: album.id,
    title: album.title,
    year: album.year,
    kind: album.kind,
    owned: album.owned,
    hasCover: album.coverPath != null,
    trackTotal: album.trackTotal,
    artist: album.artist,
    discs,
  };
}

// ---------------------------------------------------------------------------
// Report ("/report" — music section)
// ---------------------------------------------------------------------------

export interface MissingAlbumView {
  id: number;
  title: string;
  year: number | null;
  hasCover: boolean;
}

export interface MissingArtistGroup {
  artistId: number;
  artistName: string;
  albums: MissingAlbumView[];
}

export interface MusicReportData {
  totals: { artists: number; albumsOwned: number; albumsMissing: number; losslessPct: number };
  missingByArtist: MissingArtistGroup[];
}

export async function getMusicReportData(): Promise<MusicReportData> {
  const [artists, albumsOwned, albumsMissing, tracksTotal, tracksLossless] = await Promise.all([
    prisma.artist.findMany({
      select: {
        id: true,
        name: true,
        sortName: true,
        various: true,
        albums: { select: { id: true, title: true, year: true, kind: true, owned: true, coverPath: true } },
      },
    }),
    prisma.album.count({ where: { owned: true } }),
    prisma.album.count({ where: { owned: false } }),
    prisma.track.count(),
    prisma.track.count({ where: { lossless: true } }),
  ]);

  // Report threshold (SPEC-MUSIC.md "Queries"): an artist only appears once
  // we own enough of its studio catalogue to be worth completing — keeps
  // 2-of-43 completist catalogues (Zappa) out of the report. The artist page
  // itself (getArtistDetail) always shows the full catalogue regardless.
  const missingByArtist: MissingArtistGroup[] = artists
    .filter((a) => !a.various)
    .slice()
    .sort(byArtistOrder)
    .map((a) => {
      const studioAlbums = a.albums.filter((al) => al.kind === "STUDIO");
      const ownedStudio = studioAlbums.filter((al) => al.owned).length;
      const totalStudio = studioAlbums.length;
      const qualifies =
        totalStudio > 0 &&
        ownedStudio >= MUSIC_REPORT_MIN_OWNED &&
        ownedStudio / totalStudio >= MUSIC_REPORT_MIN_PCT;
      if (!qualifies) return null;

      const missingAlbums = studioAlbums.filter((al) => !al.owned);
      if (missingAlbums.length === 0) return null;

      return {
        artistId: a.id,
        artistName: a.name,
        albums: missingAlbums
          .slice()
          .sort(byYearAsc)
          .map((al) => ({ id: al.id, title: al.title, year: al.year, hasCover: al.coverPath != null })),
      };
    })
    .filter((g): g is MissingArtistGroup => g !== null);

  return {
    totals: {
      artists: artists.length,
      albumsOwned,
      albumsMissing,
      losslessPct: losslessPct(tracksTotal, tracksLossless),
    },
    missingByArtist,
  };
}
