// Data access + shaping for the music UI. Server-only (imports the Prisma
// client directly — every caller is a Server Component), mirrors the style
// of queries.ts. Contract driven by SPEC-MUSIC.md "Queries" — Worker D's UI
// code is written against these exact exported types.

import { prisma } from "@/lib/db";
import { MUSIC_GAP_MIN_OWNED, MUSIC_GAP_MIN_PCT } from "@/lib/constants";

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
  /** Cache-buster for the cover URL (album updatedAt epoch ms) — a cover's
   *  bytes can change under the same /api/cover/<id> URL, and next/image
   *  keeps per-width/per-format derivatives keyed by URL, so the URL must
   *  change when the cover does. Null when coverAlbumId is null. */
  coverVersion: number | null;
}

export interface MusicIndexData {
  totals: {
    artists: number;
    albumsOwned: number;
    tracks: number;
    losslessPct: number;
    vinylOwned: number;
    cdOwned: number;
  };
  artists: MusicIndexArtist[]; // sorted by sortName, various=true last
}

export async function getMusicIndex(): Promise<MusicIndexData> {
  const [artists, albumsOwned, tracksTotal, tracksLossless, vinylOwned, cdOwned] = await Promise.all([
    prisma.artist.findMany({
      select: {
        id: true,
        name: true,
        sortName: true,
        various: true,
        studioTotal: true,
        albums: { select: { id: true, kind: true, owned: true, year: true, coverPath: true, updatedAt: true } },
      },
    }),
    prisma.album.count({ where: { owned: true } }),
    prisma.track.count(),
    prisma.track.count({ where: { lossless: true } }),
    prisma.physicalCopy.count({ where: { medium: "VINYL" } }),
    prisma.physicalCopy.count({ where: { medium: "CD" } }),
  ]);

  const shaped: MusicIndexArtist[] = artists
    .slice()
    .sort(byArtistOrder)
    .map((a) => {
      const studioAlbums = a.albums.filter((al) => al.kind === "STUDIO");
      const coverAlbumId = pickCoverAlbumId(a.albums);
      const coverAlbum = coverAlbumId == null ? null : a.albums.find((al) => al.id === coverAlbumId);
      // See getArtistDetail's totalStudio comment: studioTotal is the
      // MusicBrainz-known count even when gap tracking never created
      // placeholders for it, so a Barenboim-style artist shows "1/282" here
      // rather than "1/1".
      return {
        id: a.id,
        name: a.name,
        various: a.various,
        ownedStudio: studioAlbums.filter((al) => al.owned).length,
        totalStudio: Math.max(a.studioTotal ?? 0, studioAlbums.length),
        coverAlbumId,
        coverVersion: coverAlbum ? coverAlbum.updatedAt.getTime() : null,
      };
    });

  return {
    totals: {
      artists: artists.length,
      albumsOwned,
      tracks: tracksTotal,
      losslessPct: losslessPct(tracksTotal, tracksLossless),
      vinylOwned,
      cdOwned,
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
  /** Physical media you own this album on ("VINYL", "CD"), independent of
   *  `owned` (digital). An album with owned=false and a non-empty list is
   *  NOT a gap: you have it, just not digitally. UI must not render it as
   *  "Missing". */
  physicalMedia: string[];
  hasCover: boolean;
  /** See MusicIndexArtist.coverVersion. Null when hasCover is false. */
  coverVersion: number | null;
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
  /** True when MusicBrainz's known studio catalogue (Artist.studioTotal) is
   *  larger than the studio Album rows actually present — i.e. gap tracking
   *  never kicked in (see constants.ts MUSIC_GAP_MIN_OWNED/MUSIC_GAP_MIN_PCT
   *  and musicbrainz.ts's reconcileArtistAlbums), so `total` above reflects
   *  the honest MusicBrainz count even though no missing-album placeholders
   *  exist to fill the grid. */
  gapTrackingOff: boolean;
}

export async function getArtistDetail(id: number): Promise<ArtistDetail | null> {
  const artist = await prisma.artist.findUnique({
    where: { id },
    include: {
      albums: { include: { _count: { select: { tracks: true } }, physicalCopies: { select: { medium: true } } } },
    },
  });
  if (!artist) return null;

  const toCatalogueAlbum = (a: (typeof artist.albums)[number]): ArtistCatalogueAlbum => ({
    id: a.id,
    title: a.title,
    year: a.year,
    owned: a.owned,
    physicalMedia: a.physicalCopies.map((c) => c.medium),
    hasCover: a.coverPath != null,
    coverVersion: a.coverPath != null ? a.updatedAt.getTime() : null,
    trackCount: a._count.tracks,
    trackTotal: a.trackTotal,
  });

  const studio: ArtistCatalogueAlbum[] = artist.albums
    .filter((a) => a.kind === "STUDIO")
    .map(toCatalogueAlbum)
    .sort(byYearAsc);

  // Owned digitally, or physical-only (scanned/logged but never ripped) —
  // same "not a gap" treatment as the studio grid above.
  const shelf: ArtistShelfAlbum[] = artist.albums
    .filter((a) => a.kind !== "STUDIO" && (a.owned || a.physicalCopies.length > 0))
    .map((a) => ({ ...toCatalogueAlbum(a), kind: a.kind }))
    .sort(byYearAsc);

  const ownedStudio = studio.filter((a) => a.owned).length;
  // studioTotal is the MusicBrainz-known count, recorded even when gap
  // tracking never created placeholders for it — fall back to the rows
  // actually present (pre-enrichment, or an artist with no MB match at all)
  // and never let a stale/short studioTotal under-report what's on disk.
  const totalStudio = Math.max(artist.studioTotal ?? 0, studio.length);
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
    gapTrackingOff: totalStudio > studio.length,
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

export interface PhysicalCopyTrackView {
  disc: number;
  trackNumber: number | null;
  title: string;
  durationSecs: number | null;
}

export interface PhysicalCopyView {
  id: number;
  medium: string; // "VINYL" | "CD" | ...
  format: string;
  inferred: boolean;
  discs: number | null;
  catalogNo: string | null;
  label: string | null;
  pressYear: number | null;
  condition: string | null;
  notes: string | null;
  /** Set once this copy is linked to a specific MusicBrainz release. */
  releaseMbid: string | null;
  /** True when this pressing has its own cover art — served at /api/physical-cover/<id>. */
  hasCover: boolean;
  /** Pressing-specific tracklist (see PhysicalTrack) — empty unless linked to a release. */
  tracks: PhysicalCopyTrackView[];
}

export interface AlbumDetail {
  id: number;
  title: string;
  year: number | null;
  kind: string;
  owned: boolean;
  /** See ArtistCatalogueAlbum.physicalMedia. Empty when you own no physical copy. */
  copies: PhysicalCopyView[];
  /** Provenance of the digital files (cd | itunes | download | vinyl-code), null = unconfirmed. */
  digitalSource: string | null;
  hasCover: boolean;
  /** See MusicIndexArtist.coverVersion. Null when hasCover is false. */
  coverVersion: number | null;
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
      physicalCopies: { include: { tracks: true } },
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
    copies: album.physicalCopies
      .slice()
      .sort((a, b) => a.medium.localeCompare(b.medium))
      .map((c) => ({
        id: c.id,
        medium: c.medium,
        format: c.format,
        inferred: c.inferred,
        discs: c.discs,
        catalogNo: c.catalogNo,
        label: c.label,
        pressYear: c.pressYear,
        condition: c.condition,
        notes: c.notes,
        releaseMbid: c.releaseMbid,
        hasCover: c.coverPath != null,
        tracks: c.tracks
          .slice()
          .sort((a, b) => a.disc - b.disc || (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
          .map((t) => ({ disc: t.disc, trackNumber: t.trackNumber, title: t.title, durationSecs: t.durationSecs })),
      })),
    digitalSource: album.digitalSource,
    hasCover: album.coverPath != null,
    coverVersion: album.coverPath != null ? album.updatedAt.getTime() : null,
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
  /** See MusicIndexArtist.coverVersion. Null when hasCover is false. */
  coverVersion: number | null;
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
        albums: {
          select: {
            id: true,
            title: true,
            year: true,
            kind: true,
            owned: true,
            coverPath: true,
            updatedAt: true,
            physicalCopies: { select: { id: true } },
          },
        },
      },
    }),
    prisma.album.count({ where: { owned: true } }),
    prisma.album.count({ where: { owned: false } }),
    prisma.track.count(),
    prisma.track.count({ where: { lossless: true } }),
  ]);

  // Report threshold (SPEC-MUSIC.md "Queries"): missing-album placeholders
  // are only created for an artist once we own enough of its studio
  // catalogue to be worth completing (see constants.ts MUSIC_GAP_MIN_OWNED /
  // MUSIC_GAP_MIN_PCT, enforced at placeholder-creation time in
  // musicbrainz.ts's reconcileArtistAlbums) — a sub-threshold artist simply
  // has no owned=false rows, so missingAlbums.length === 0 already excludes
  // it below. This check is kept as belt-and-braces in case stale rows ever
  // exist (e.g. between an enrichment run and the threshold changing).
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
        ownedStudio >= MUSIC_GAP_MIN_OWNED &&
        ownedStudio / totalStudio >= MUSIC_GAP_MIN_PCT;
      if (!qualifies) return null;

      // Owned=false but with a PhysicalCopy isn't a gap — you have it, just
      // not digitally — so it's excluded from the missing-albums report.
      const missingAlbums = studioAlbums.filter((al) => !al.owned && al.physicalCopies.length === 0);
      if (missingAlbums.length === 0) return null;

      return {
        artistId: a.id,
        artistName: a.name,
        albums: missingAlbums
          .slice()
          .sort(byYearAsc)
          .map((al) => ({
            id: al.id,
            title: al.title,
            year: al.year,
            hasCover: al.coverPath != null,
            coverVersion: al.coverPath != null ? al.updatedAt.getTime() : null,
          })),
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

// ---------------------------------------------------------------------------
// Formats report ("/music/formats")
// ---------------------------------------------------------------------------

export interface FormatsCrateAlbum {
  id: number;
  title: string;
  year: number | null;
  artistId: number;
  artistName: string;
  format: string;
  inferred: boolean;
  discs: number; // resolved: explicit discs, else parsed from format ("2xLP"), else 1
  catalogNo: string | null;
  label: string | null;
  pressYear: number | null;
  condition: string | null;
  notes: string | null;
  digitallyOwned: boolean;
  hasCover: boolean;
  coverVersion: number | null;
}

export interface UnconfirmedSourceAlbum {
  id: number;
  title: string;
  artistName: string;
  /** Distinct track codecs, e.g. ["aac"] or ["drm"] — why this album isn't
   *  assumed to be a CD rip. */
  codecs: string[];
}

export interface FormatsReportData {
  totals: {
    cdAlbums: number;
    vinylAlbums: number;
    bothFormats: number;
    digitalOnly: number; // owned digitally, no physical copy of any medium
    vinylDiscs: number;
  };
  vinylByFormat: { format: string; count: number }[];
  /** Owned digital albums by Album.digitalSource (nulls excluded — those are `unconfirmed`). */
  digitalSources: { source: string; count: number }[];
  crate: FormatsCrateAlbum[]; // vinyl albums, artist order then year
  unconfirmed: UnconfirmedSourceAlbum[]; // digital albums whose digitalSource is still null
}

/** "2xLP" -> 2, "LP"/"7\"" -> 1; explicit discs field wins. */
function resolveDiscs(format: string, discs: number | null): number {
  if (discs != null && discs > 0) return discs;
  const m = /^(\d{1,2})\s*x/i.exec(format.trim());
  return m ? Number(m[1]) : 1;
}

export async function getFormatsReport(): Promise<FormatsReportData> {
  const [copies, digitalOnly, unconfirmedRows] = await Promise.all([
    prisma.physicalCopy.findMany({
      include: {
        album: {
          select: {
            id: true,
            title: true,
            year: true,
            owned: true,
            coverPath: true,
            updatedAt: true,
            artist: { select: { id: true, name: true, sortName: true, various: true } },
          },
        },
      },
    }),
    prisma.album.count({ where: { owned: true, physicalCopies: { none: {} } } }),
    // Digital albums whose file provenance is still unconfirmed. The CD/source
    // backfill (POST /api/backfill-cds) stamps digitalSource for the safely
    // inferable cases (all-ALAC => cd, DRM => itunes); what's left is a
    // purchase or download only Mark can classify, via /api/digital-source.
    prisma.album.findMany({
      where: {
        owned: true,
        digitalSource: null,
        tracks: { some: {} },
      },
      select: {
        id: true,
        title: true,
        artist: { select: { name: true, sortName: true } },
        tracks: { select: { codec: true } },
      },
    }),
  ]);

  const sourceCounts = await prisma.album.groupBy({
    by: ["digitalSource"],
    where: { owned: true, digitalSource: { not: null } },
    _count: { _all: true },
  });

  const vinyl = copies.filter((c) => c.medium === "VINYL");
  const cds = copies.filter((c) => c.medium === "CD");
  const vinylAlbumIds = new Set(vinyl.map((c) => c.albumId));
  const bothFormats = cds.filter((c) => vinylAlbumIds.has(c.albumId)).length;

  const byFormat = new Map<string, number>();
  for (const c of vinyl) byFormat.set(c.format, (byFormat.get(c.format) ?? 0) + 1);

  const crate: FormatsCrateAlbum[] = vinyl
    .slice()
    .sort(
      (a, b) =>
        a.album.artist.sortName.localeCompare(b.album.artist.sortName) ||
        (a.album.year ?? 9999) - (b.album.year ?? 9999),
    )
    .map((c) => ({
      id: c.album.id,
      title: c.album.title,
      year: c.album.year,
      artistId: c.album.artist.id,
      artistName: c.album.artist.name,
      format: c.format,
      inferred: c.inferred,
      discs: resolveDiscs(c.format, c.discs),
      catalogNo: c.catalogNo,
      label: c.label,
      pressYear: c.pressYear,
      condition: c.condition,
      notes: c.notes,
      digitallyOwned: c.album.owned,
      hasCover: c.album.coverPath != null,
      coverVersion: c.album.coverPath != null ? c.album.updatedAt.getTime() : null,
    }));

  const unconfirmed: UnconfirmedSourceAlbum[] = unconfirmedRows
    .slice()
    .sort((a, b) => a.artist.sortName.localeCompare(b.artist.sortName) || a.title.localeCompare(b.title))
    .map((al) => ({
      id: al.id,
      title: al.title,
      artistName: al.artist.name,
      codecs: Array.from(new Set(al.tracks.map((t) => t.codec ?? "unknown"))).sort(),
    }));

  return {
    totals: {
      cdAlbums: cds.length,
      vinylAlbums: vinyl.length,
      bothFormats,
      digitalOnly,
      vinylDiscs: vinyl.reduce((sum, c) => sum + resolveDiscs(c.format, c.discs), 0),
    },
    vinylByFormat: Array.from(byFormat.entries())
      .map(([format, count]) => ({ format, count }))
      .sort((a, b) => b.count - a.count || a.format.localeCompare(b.format)),
    digitalSources: sourceCounts
      .map((s) => ({ source: s.digitalSource as string, count: s._count._all }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    crate,
    unconfirmed,
  };
}
