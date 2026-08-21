// Data access + shaping for the UI. Server-only (imports the Prisma client
// directly — every caller is a Server Component). Anything handed to a
// Client Component is plain data: BigInt sizeBytes is converted to a number
// here, Dates are ISO strings, so nothing needs re-shaping downstream.

import { prisma } from "@/lib/db";
import { resolutionTier, type Format, type ResolutionTier } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

export function formatDuration(secs: number | null | undefined): string {
  if (!secs || secs <= 0) return "—";
  const totalMins = Math.round(secs / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function formatRuntimeMins(mins: number | null | undefined): string {
  if (!mins || mins <= 0) return "—";
  return formatDuration(mins * 60);
}

export function resolutionLabel(width: number | null, height: number | null): string {
  if (!width || !height) return "Unknown resolution";
  return `${width}×${height}`;
}

// Best (lowest-rank) resolution tier across a film's versions — used for the
// single "best you own it in" ResolutionBadge on cards/rows where showing
// every version's tier would be clutter.
function bestResolutionTier(
  versions: { width: number | null; height: number | null }[],
): ResolutionTier {
  return versions.reduce<ResolutionTier>(
    (best, v) => {
      const t = resolutionTier(v.width, v.height);
      return t.rank < best.rank ? t : best;
    },
    { label: "?", rank: 9 },
  );
}

// ---------------------------------------------------------------------------
// Library ("/")
// ---------------------------------------------------------------------------

export interface LibraryFilm {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  posterPath: string | null;
  collectionId: number | null;
  createdAt: string;
  formats: Format[];
  discCount: number;
  bestTier: ResolutionTier;
}

export interface LibraryData {
  films: LibraryFilm[];
  filmCount: number;
  discCount: number;
}

export async function getLibraryFilms(): Promise<LibraryData> {
  const films = await prisma.film.findMany({
    where: { owned: true },
    orderBy: { sortTitle: "asc" },
    select: {
      id: true,
      title: true,
      sortTitle: true,
      year: true,
      posterPath: true,
      collectionId: true,
      createdAt: true,
      versions: { select: { format: true, width: true, height: true } },
    },
  });

  const shaped: LibraryFilm[] = films.map((f) => ({
    id: f.id,
    title: f.title,
    sortTitle: f.sortTitle,
    year: f.year,
    posterPath: f.posterPath,
    collectionId: f.collectionId,
    createdAt: f.createdAt.toISOString(),
    formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    discCount: f.versions.length,
    bestTier: bestResolutionTier(f.versions),
  }));

  return {
    films: shaped,
    filmCount: shaped.length,
    discCount: shaped.reduce((sum, f) => sum + f.discCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Film detail ("/film/[id]")
// ---------------------------------------------------------------------------

export interface AudioTrackView {
  id: number;
  codec: string | null;
  profile: string | null;
  language: string | null;
  channels: number | null;
  layout: string | null;
  title: string | null;
}

export interface VersionView {
  id: number;
  edition: string | null;
  format: Format;
  width: number | null;
  height: number | null;
  resolution: string;
  tier: ResolutionTier;
  videoCodec: string | null;
  videoRange: string | null;
  container: string | null;
  sizeLabel: string;
  durationLabel: string;
  jellyfinId: string | null;
  audioTracks: AudioTrackView[];
}

export interface CollectionMemberView {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  owned: boolean;
  releaseDate: string | null;
  bestTier: ResolutionTier;
}

export interface FilmDetail {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  releaseDate: string | null;
  runtimeLabel: string;
  rating: number | null;
  genres: string[];
  matchConfidence: string;
  versions: VersionView[];
  collection: { id: number; name: string; members: CollectionMemberView[] } | null;
}

export async function getFilmDetail(id: number): Promise<FilmDetail | null> {
  const film = await prisma.film.findUnique({
    where: { id },
    include: {
      versions: { include: { audioTracks: true } },
      collection: {
        include: {
          films: {
            orderBy: { releaseDate: "asc" },
            include: { versions: { select: { width: true, height: true } } },
          },
        },
      },
    },
  });
  if (!film) return null;

  const versions: VersionView[] = film.versions.map((v) => ({
    id: v.id,
    edition: v.edition,
    format: v.format as Format,
    width: v.width,
    height: v.height,
    resolution: resolutionLabel(v.width, v.height),
    tier: resolutionTier(v.width, v.height),
    videoCodec: v.videoCodec,
    videoRange: v.videoRange,
    container: v.container,
    sizeLabel: formatBytes(v.sizeBytes === null ? null : Number(v.sizeBytes)),
    durationLabel: formatDuration(v.durationSecs),
    jellyfinId: v.jellyfinId,
    audioTracks: v.audioTracks.map((a) => ({
      id: a.id,
      codec: a.codec,
      profile: a.profile,
      language: a.language,
      channels: a.channels,
      layout: a.layout,
      title: a.title,
    })),
  }));

  return {
    id: film.id,
    title: film.title,
    year: film.year,
    posterPath: film.posterPath,
    backdropPath: film.backdropPath,
    overview: film.overview,
    releaseDate: film.releaseDate ? film.releaseDate.toISOString() : null,
    runtimeLabel: formatRuntimeMins(film.runtimeMins),
    rating: film.rating,
    genres: film.genres ? film.genres.split(",").map((g) => g.trim()).filter(Boolean) : [],
    matchConfidence: film.matchConfidence,
    versions,
    collection: film.collection
      ? {
          id: film.collection.id,
          name: film.collection.name,
          members: film.collection.films.map((m) => ({
            id: m.id,
            title: m.title,
            year: m.year,
            posterPath: m.posterPath,
            owned: m.owned,
            releaseDate: m.releaseDate ? m.releaseDate.toISOString() : null,
            bestTier: bestResolutionTier(m.versions),
          })),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Collections ("/collections", "/collections/[id]")
// ---------------------------------------------------------------------------

export interface CollectionSummary {
  id: number;
  name: string;
  posterPath: string | null;
  collagePosters: (string | null)[]; // used only when posterPath is null
  ownedCount: number;
  totalCount: number;
  complete: boolean;
}

export async function getCollections(): Promise<CollectionSummary[]> {
  const collections = await prisma.collection.findMany({
    orderBy: { name: "asc" },
    include: { films: { orderBy: { releaseDate: "asc" } } },
  });

  return collections
    .filter((c) => c.films.length > 0)
    .map((c) => {
      const ownedCount = c.films.filter((f) => f.owned).length;
      return {
        id: c.id,
        name: c.name,
        posterPath: c.posterPath,
        collagePosters: c.films.slice(0, 4).map((f) => f.posterPath),
        ownedCount,
        totalCount: c.films.length,
        complete: ownedCount === c.films.length,
      };
    });
}

export interface TimelineFilm {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  owned: boolean;
  releaseDate: string | null;
  formats: Format[];
  bestTier: ResolutionTier;
}

export interface CollectionDetail {
  id: number;
  name: string;
  overview: string | null;
  backdropPath: string | null;
  ownedCount: number;
  totalCount: number;
  films: TimelineFilm[];
}

export async function getCollectionDetail(id: number): Promise<CollectionDetail | null> {
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      films: {
        orderBy: { releaseDate: "asc" },
        include: { versions: { select: { format: true, width: true, height: true } } },
      },
    },
  });
  if (!collection) return null;

  const films: TimelineFilm[] = collection.films.map((f) => ({
    id: f.id,
    title: f.title,
    year: f.year,
    posterPath: f.posterPath,
    owned: f.owned,
    releaseDate: f.releaseDate ? f.releaseDate.toISOString() : null,
    formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    bestTier: bestResolutionTier(f.versions),
  }));

  return {
    id: collection.id,
    name: collection.name,
    overview: collection.overview,
    backdropPath: collection.backdropPath,
    ownedCount: films.filter((f) => f.owned).length,
    totalCount: films.length,
    films,
  };
}

// ---------------------------------------------------------------------------
// TV — Shows ("/shows", "/shows/[id]")
// ---------------------------------------------------------------------------

export interface ShowSummary {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  posterPath: string | null;
  ownedEpisodeCount: number;
  totalEpisodeCount: number;
  complete: boolean;
}

export async function getShows(): Promise<ShowSummary[]> {
  const shows = await prisma.show.findMany({
    orderBy: { sortTitle: "asc" },
    include: {
      seasons: {
        select: { episodes: { select: { owned: true } } },
      },
    },
  });

  return shows.map((s) => {
    const episodes = s.seasons.flatMap((se) => se.episodes);
    const ownedEpisodeCount = episodes.filter((e) => e.owned).length;
    const totalEpisodeCount = episodes.length;
    return {
      id: s.id,
      title: s.title,
      sortTitle: s.sortTitle,
      year: s.year,
      posterPath: s.posterPath,
      ownedEpisodeCount,
      totalEpisodeCount,
      complete: totalEpisodeCount > 0 && ownedEpisodeCount === totalEpisodeCount,
    };
  });
}

export interface EpisodeFileView {
  id: number;
  format: Format;
  width: number | null;
  height: number | null;
  resolution: string;
  tier: ResolutionTier;
  videoRange: string | null;
  audioSummary: string | null;
  sizeLabel: string;
  jellyfinId: string | null;
}

export interface EpisodeView {
  id: number;
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
  owned: boolean;
  files: EpisodeFileView[];
}

export interface SeasonView {
  id: number;
  seasonNumber: number;
  name: string | null;
  posterPath: string | null;
  airYear: number | null;
  ownedCount: number;
  totalCount: number;
  episodes: EpisodeView[];
}

export interface ShowDetail {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  status: string | null;
  rating: number | null;
  genres: string[];
  matchConfidence: string;
  ownedEpisodeCount: number;
  totalEpisodeCount: number;
  seasons: SeasonView[];
}

export async function getShowDetail(id: number): Promise<ShowDetail | null> {
  const show = await prisma.show.findUnique({
    where: { id },
    include: {
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: {
          // Episodes are always ordered by episodeNumber — some shows (e.g.
          // DVD-order releases like Firefly) have air dates that don't match
          // production/disc order, so airDate must never be used here.
          episodes: {
            orderBy: { episodeNumber: "asc" },
            include: { files: true },
          },
        },
      },
    },
  });
  if (!show) return null;

  const seasons: SeasonView[] = show.seasons.map((se) => {
    const episodes: EpisodeView[] = se.episodes.map((e) => ({
      id: e.id,
      episodeNumber: e.episodeNumber,
      name: e.name,
      overview: e.overview,
      stillPath: e.stillPath,
      airDate: e.airDate ? e.airDate.toISOString() : null,
      owned: e.owned,
      files: e.files.map((f) => ({
        id: f.id,
        format: f.format as Format,
        width: f.width,
        height: f.height,
        resolution: resolutionLabel(f.width, f.height),
        tier: resolutionTier(f.width, f.height),
        videoRange: f.videoRange,
        audioSummary: f.audioSummary,
        sizeLabel: formatBytes(f.sizeBytes === null ? null : Number(f.sizeBytes)),
        jellyfinId: f.jellyfinId,
      })),
    }));
    const ownedCount = episodes.filter((e) => e.owned).length;
    return {
      id: se.id,
      seasonNumber: se.seasonNumber,
      name: se.name,
      posterPath: se.posterPath,
      airYear: se.airDate ? se.airDate.getFullYear() : null,
      ownedCount,
      totalCount: episodes.length,
      episodes,
    };
  });

  const ownedEpisodeCount = seasons.reduce((sum, s) => sum + s.ownedCount, 0);
  const totalEpisodeCount = seasons.reduce((sum, s) => sum + s.totalCount, 0);

  return {
    id: show.id,
    title: show.title,
    year: show.year,
    posterPath: show.posterPath,
    backdropPath: show.backdropPath,
    overview: show.overview,
    status: show.status,
    rating: show.rating,
    genres: show.genres ? show.genres.split(",").map((g) => g.trim()).filter(Boolean) : [],
    matchConfidence: show.matchConfidence,
    ownedEpisodeCount,
    totalEpisodeCount,
    seasons,
  };
}

// ---------------------------------------------------------------------------
// Report ("/report")
// ---------------------------------------------------------------------------

export interface MissingFilmView {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export interface MissingGroup {
  collectionId: number;
  collectionName: string;
  films: MissingFilmView[];
}

export interface UpgradeCandidate {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  discCount: number;
  formats: Format[];
}

export interface IssueFilm {
  id: number;
  title: string;
  year: number | null;
  matchConfidence: string;
  hasUnknownFormatVersion: boolean;
  missingYear: boolean;
}

export interface ReportData {
  totals: {
    filmsOwned: number;
    discs: number;
    uhdFilmCount: number;
    blurayCount: number;
    dvdCount: number;
    collectionsComplete: number;
    collectionsIncomplete: number;
    missingCount: number;
  };
  missingByCollection: MissingGroup[];
  upgradeCandidates: UpgradeCandidate[];
  issues: IssueFilm[];
}

export async function getReportData(): Promise<ReportData> {
  const [ownedFilms, missingFilms, collections] = await Promise.all([
    prisma.film.findMany({
      where: { owned: true },
      orderBy: { sortTitle: "asc" },
      include: { versions: true },
    }),
    prisma.film.findMany({
      where: { owned: false },
      orderBy: { releaseDate: "asc" },
      include: { collection: true },
    }),
    prisma.collection.findMany({ include: { films: true } }),
  ]);

  const discs = ownedFilms.flatMap((f) => f.versions);
  const blurayCount = discs.filter((v) => v.format === "BLURAY").length;
  const dvdCount = discs.filter((v) => v.format === "DVD").length;
  const uhdFilmCount = ownedFilms.filter((f) =>
    f.versions.some((v) => v.format === "UHD"),
  ).length;

  const collectionsComplete = collections.filter(
    (c) => c.films.length > 0 && c.films.every((f) => f.owned),
  ).length;
  const collectionsWithFilms = collections.filter((c) => c.films.length > 0);
  const collectionsIncomplete = collectionsWithFilms.length - collectionsComplete;

  const missingByCollectionMap = new Map<number, MissingGroup>();
  for (const f of missingFilms) {
    if (!f.collection) continue;
    const key = f.collection.id;
    if (!missingByCollectionMap.has(key)) {
      missingByCollectionMap.set(key, {
        collectionId: f.collection.id,
        collectionName: f.collection.name,
        films: [],
      });
    }
    missingByCollectionMap.get(key)!.films.push({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
    });
  }

  const upgradeCandidates: UpgradeCandidate[] = ownedFilms
    .filter(
      (f) =>
        f.versions.length > 0 &&
        f.versions.every((v) => v.format === "DVD" || v.format === "SD"),
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
      discCount: f.versions.length,
      formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    }));

  const issues: IssueFilm[] = ownedFilms
    .filter(
      (f) =>
        f.matchConfidence === "LOW" ||
        f.matchConfidence === "UNMATCHED" ||
        f.versions.some((v) => v.format === "UNKNOWN") ||
        f.year === null,
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      year: f.year,
      matchConfidence: f.matchConfidence,
      hasUnknownFormatVersion: f.versions.some((v) => v.format === "UNKNOWN"),
      missingYear: f.year === null,
    }));

  return {
    totals: {
      filmsOwned: ownedFilms.length,
      discs: discs.length,
      uhdFilmCount,
      blurayCount,
      dvdCount,
      collectionsComplete,
      collectionsIncomplete,
      missingCount: missingFilms.length,
    },
    missingByCollection: Array.from(missingByCollectionMap.values()),
    upgradeCandidates,
    issues,
  };
}

// ---------------------------------------------------------------------------
// TV report data ("/report" — TV section)
// ---------------------------------------------------------------------------

export interface ShowGapLine {
  key: string;
  text: string;
}

export interface ShowGapGroup {
  showId: number;
  showTitle: string;
  posterPath: string | null;
  lines: ShowGapLine[];
}

export interface TvReportData {
  showsTotal: number;
  showsComplete: number;
  episodesOwned: number;
  episodesTotal: number;
  missingByShow: ShowGapGroup[];
}

function padEpisodeNumber(n: number): string {
  return n.toString().padStart(2, "0");
}

// Collapse a set of missing episode numbers within one season into short
// range labels: [1,2,3,7] -> "E01-E03, E07".
function episodeRangeLabel(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(
      start === prev
        ? `E${padEpisodeNumber(start)}`
        : `E${padEpisodeNumber(start)}-E${padEpisodeNumber(prev)}`,
    );
    start = n;
    prev = n;
  }
  parts.push(
    start === prev
      ? `E${padEpisodeNumber(start)}`
      : `E${padEpisodeNumber(start)}-E${padEpisodeNumber(prev)}`,
  );
  return parts.join(", ");
}

export async function getTvReportData(): Promise<TvReportData> {
  const shows = await prisma.show.findMany({
    orderBy: { sortTitle: "asc" },
    include: {
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: {
          episodes: {
            orderBy: { episodeNumber: "asc" },
            select: { episodeNumber: true, owned: true },
          },
        },
      },
    },
  });

  let episodesOwned = 0;
  let episodesTotal = 0;
  let showsComplete = 0;
  const missingByShow: ShowGapGroup[] = [];

  for (const show of shows) {
    const lines: ShowGapLine[] = [];
    let ownedForShow = 0;
    let totalForShow = 0;

    for (const season of show.seasons) {
      const total = season.episodes.length;
      const owned = season.episodes.filter((e) => e.owned).length;
      ownedForShow += owned;
      totalForShow += total;

      if (total > 0 && owned === 0) {
        // Whole season missing — one summary line, not one per episode.
        lines.push({
          key: `s${season.seasonNumber}`,
          text: `Season ${season.seasonNumber} — ${total} episode${total === 1 ? "" : "s"}`,
        });
      } else if (owned < total) {
        const missingNums = season.episodes.filter((e) => !e.owned).map((e) => e.episodeNumber);
        lines.push({
          key: `s${season.seasonNumber}`,
          text: `S${padEpisodeNumber(season.seasonNumber)}: ${episodeRangeLabel(missingNums)} missing`,
        });
      }
    }

    episodesOwned += ownedForShow;
    episodesTotal += totalForShow;
    if (totalForShow > 0 && ownedForShow === totalForShow) showsComplete++;

    if (lines.length > 0) {
      missingByShow.push({
        showId: show.id,
        showTitle: show.title,
        posterPath: show.posterPath,
        lines,
      });
    }
  }

  return {
    showsTotal: shows.length,
    showsComplete,
    episodesOwned,
    episodesTotal,
    missingByShow,
  };
}
