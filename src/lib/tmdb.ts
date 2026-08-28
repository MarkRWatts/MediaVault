// TMDB enrichment: match films, pull details + collection membership, cache
// posters/backdrops locally. Degrades gracefully with no TMDB_API_KEY.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { normalizeTitle, sortTitle } from "@/lib/parse";
import type { Film, Show } from "@/generated/prisma/client";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const CALL_DELAY_MS = 50;
const PROGRESS_UPDATE_EVERY = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authMode(key: string): "bearer" | "query" {
  return key.length > 60 || key.includes(".") ? "bearer" : "query";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tmdbFetch(pathname: string, params: Record<string, string> = {}): Promise<any> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not set");

  const url = new URL(`${TMDB_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {};
  if (authMode(key) === "bearer") headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const res = await fetch(url.toString(), { headers });
  await sleep(CALL_DELAY_MS);
  if (!res.ok) throw new Error(`TMDB ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

async function cachePoster(tmdbPath: string | null | undefined, size: "w300" | "w342" | "w780"): Promise<void> {
  if (!tmdbPath) return;
  const rel = tmdbPath.replace(/^\//, "");
  const dest = path.join(POSTER_CACHE_DIR, size, rel);

  try {
    await fs.access(dest);
    return; // already cached
  } catch {
    // fall through and download
  }

  try {
    const res = await fetch(`${TMDB_IMAGE_BASE}/${size}${tmdbPath}`);
    if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
  } catch {
    // Poster caching is best-effort; a missing poster shouldn't fail enrichment.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureCollection(collStub: any, collectionCache: Map<number, any>, log: string[]): Promise<void> {
  await prisma.collection.upsert({
    where: { id: collStub.id },
    create: {
      id: collStub.id,
      name: collStub.name,
      posterPath: collStub.poster_path ?? null,
      backdropPath: collStub.backdrop_path ?? null,
    },
    update: {
      name: collStub.name,
      posterPath: collStub.poster_path ?? null,
      backdropPath: collStub.backdrop_path ?? null,
    },
  });
  await cachePoster(collStub.poster_path, "w342");
  await cachePoster(collStub.backdrop_path, "w780");

  if (collectionCache.has(collStub.id)) return; // already fetched this run

  const detail = await tmdbFetch(`/collection/${collStub.id}`);
  collectionCache.set(collStub.id, detail);

  if (detail.overview) {
    await prisma.collection.update({ where: { id: collStub.id }, data: { overview: detail.overview } });
  }

  const now = Date.now();
  for (const part of detail.parts ?? []) {
    if (!part.release_date) continue;
    const releaseDate = new Date(part.release_date);
    if (Number.isNaN(releaseDate.getTime()) || releaseDate.getTime() > now) continue; // unreleased

    const existingPart = await prisma.film.findUnique({ where: { tmdbId: part.id } });
    if (existingPart) continue;

    await prisma.film.create({
      data: {
        title: part.title,
        sortTitle: sortTitle(part.title),
        year: releaseDate.getFullYear(),
        tmdbId: part.id,
        overview: part.overview ?? null,
        posterPath: part.poster_path ?? null,
        backdropPath: part.backdrop_path ?? null,
        releaseDate,
        rating: part.vote_average ?? null,
        owned: false,
        matchConfidence: "EXACT",
        collectionId: collStub.id,
      },
    });
    await cachePoster(part.poster_path, "w342");
    await cachePoster(part.backdrop_path, "w780");
    log.push(`Added missing collection film "${part.title}" (${releaseDate.getFullYear()}) from "${collStub.name}"`);
  }
}

// --- Barcode scan-to-collection ---

export interface MovieSearchHit {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

/**
 * Search TMDB for a movie by title (+ optional year), preferring an exact
 * normalised-title match near the right year over TMDB's raw ranking — the
 * same "pickHit" logic enrichOneFilm uses inline against an existing Film
 * row, factored out here so the barcode scan flow (which starts from a bare
 * title guess, no Film row yet) can reuse the same match quality.
 */
export async function searchMovieByTitleYear(title: string, year: number | null): Promise<MovieSearchHit | null> {
  const want = normalizeTitle(title);
  const yearOk = (r: { release_date?: string }) =>
    !year || !r.release_date || Math.abs(Number(r.release_date.slice(0, 4)) - year) <= 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pickHit = (results: any[] | undefined): any => {
    if (!results?.length) return undefined;
    return results.slice(0, 5).find((r) => normalizeTitle(r.title ?? "") === want && yearOk(r)) ?? results[0];
  };

  const yearParams: Record<string, string> = year ? { year: String(year) } : {};
  let hit = pickHit((await tmdbFetch("/search/movie", { query: title, ...yearParams })).results);
  if (!hit && year) {
    hit = pickHit((await tmdbFetch("/search/movie", { query: title })).results);
  }
  if (!hit && normalizeTitle(title) !== title.toLowerCase()) {
    hit = pickHit((await tmdbFetch("/search/movie", { query: normalizeTitle(title), ...yearParams })).results);
  }
  if (!hit) return null;

  return {
    tmdbId: hit.id,
    title: hit.title,
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) : null,
    posterPath: hit.poster_path ?? null,
  };
}

/**
 * Top-N raw TMDB title search results, for the barcode scan page's manual
 * fallback (an unresolved barcode → the user types a title and picks from a
 * list, rather than the single best-guess searchMovieByTitleYear does).
 */
export async function searchMoviesByTitle(title: string, year?: number | null): Promise<MovieSearchHit[]> {
  const yearParams: Record<string, string> = year ? { year: String(year) } : {};
  const data = await tmdbFetch("/search/movie", { query: title, ...yearParams });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.results ?? []).slice(0, 5).map((r: any) => ({
    tmdbId: r.id,
    title: r.title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    posterPath: r.poster_path ?? null,
  }));
}

export interface FilmRef {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  owned: boolean;
}

/**
 * Find the Film row for a TMDB movie id, creating an owned:false placeholder
 * (same shape ensureCollection creates for missing collection members) if
 * none exists yet. Used by the barcode-add flow, which may be registering a
 * disc for a film that's never been scanned/ripped before.
 */
export async function findOrCreateFilmByTmdbId(tmdbId: number): Promise<FilmRef> {
  const existing = await prisma.film.findUnique({ where: { tmdbId } });
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      year: existing.year,
      posterPath: existing.posterPath,
      owned: existing.owned,
    };
  }

  const details = await tmdbFetch(`/movie/${tmdbId}`);
  const releaseDate = details.release_date ? new Date(details.release_date) : null;
  const year = releaseDate && !Number.isNaN(releaseDate.getTime()) ? releaseDate.getFullYear() : null;

  const film = await prisma.film.create({
    data: {
      title: details.title,
      sortTitle: sortTitle(details.title),
      year,
      tmdbId,
      imdbId: details.imdb_id ?? null,
      overview: details.overview ?? null,
      posterPath: details.poster_path ?? null,
      backdropPath: details.backdrop_path ?? null,
      releaseDate,
      runtimeMins: details.runtime ?? null,
      rating: details.vote_average ?? null,
      genres: details.genres?.length
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          details.genres.map((g: any) => g.name).join(", ")
        : null,
      owned: false,
      matchConfidence: "EXACT",
    },
  });
  await cachePoster(details.poster_path, "w342");
  await cachePoster(details.backdrop_path, "w780");

  if (details.belongs_to_collection) {
    try {
      await ensureCollection(details.belongs_to_collection, new Map(), []);
      await prisma.film.update({
        where: { id: film.id },
        data: { collectionId: details.belongs_to_collection.id },
      });
    } catch {
      // Collection backfill is a bonus, not a requirement — the film row
      // itself is already created above.
    }
  }

  return { id: film.id, title: film.title, year: film.year, posterPath: film.posterPath, owned: false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichOneFilm(film: Film, log: string[], collectionCache: Map<number, any>): Promise<void> {
  let tmdbId: number | null = null;
  let confidence: "EXACT" | "SEARCH" | "LOW" = "EXACT";

  if (film.imdbId) {
    const found = await tmdbFetch(`/find/${film.imdbId}`, { external_source: "imdb_id" });
    const hit = found.movie_results?.[0];
    if (hit) tmdbId = hit.id;
  }

  if (tmdbId == null && film.tmdbId) {
    tmdbId = film.tmdbId;
    confidence = "EXACT";
  }

  if (tmdbId == null) {
    // Among the top hits, prefer an exact normalised-title match near the
    // right year — TMDB's ranking alone can put e.g. "…Part 1" above a
    // "…Part 2" query, and trusting results[0] blindly corrupts identities.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickHit = (results: any[] | undefined): any => {
      if (!results?.length) return undefined;
      const want = normalizeTitle(film.title);
      const yearOk = (r: { release_date?: string }) =>
        !film.year || !r.release_date || Math.abs(Number(r.release_date.slice(0, 4)) - film.year) <= 1;
      return results.slice(0, 5).find((r) => normalizeTitle(r.title ?? "") === want && yearOk(r)) ?? results[0];
    };

    const yearParams: Record<string, string> = film.year ? { year: String(film.year) } : {};
    let hit = pickHit((await tmdbFetch("/search/movie", { query: film.title, ...yearParams })).results);
    if (hit) {
      confidence = "SEARCH";
    } else if (film.year) {
      hit = pickHit((await tmdbFetch("/search/movie", { query: film.title })).results);
      if (hit) confidence = "LOW";
    }
    if (!hit && normalizeTitle(film.title) !== film.title.toLowerCase()) {
      // Accented/punctuated titles can miss — retry with the stripped form.
      hit = pickHit((await tmdbFetch("/search/movie", { query: normalizeTitle(film.title), ...yearParams })).results);
      if (hit) confidence = "LOW";
    }
    if (hit) tmdbId = hit.id;
  } else if (confidence !== "EXACT") {
    confidence = "EXACT";
  }

  if (tmdbId == null) {
    log.push(`No TMDB match for "${film.title}"${film.year ? ` (${film.year})` : ""}`);
    return;
  }

  const details = await tmdbFetch(`/movie/${tmdbId}`);

  if (confidence === "LOW") {
    log.push(`Low-confidence match: "${film.title}"${film.year ? ` (${film.year})` : ""} -> "${details.title}" (tmdb:${tmdbId})`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {
    tmdbId,
    overview: details.overview ?? null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
    releaseDate: details.release_date ? new Date(details.release_date) : null,
    runtimeMins: details.runtime ?? null,
    rating: details.vote_average ?? null,
    genres: details.genres?.length ? details.genres.map((g: { name: string }) => g.name).join(", ") : null,
    matchConfidence: confidence,
  };

  // Filename-derived year wins when present; backfill from TMDB otherwise
  // (files named without a year would stay year-less forever).
  if (!film.year && details.release_date) updateData.year = Number(details.release_date.slice(0, 4));

  if (!film.imdbId && details.imdb_id) updateData.imdbId = details.imdb_id;

  // Another row may already hold this tmdbId: either a missing-film
  // placeholder created from collection membership (absorb it — the film on
  // disk takes its place), or a genuine duplicate owned film (merge into it).
  const holder = await prisma.film.findUnique({
    where: { tmdbId },
    include: { versions: { select: { id: true } } },
  });
  if (holder && holder.id !== film.id) {
    if (!holder.owned && holder.versions.length === 0) {
      await prisma.film.delete({ where: { id: holder.id } });
      log.push(`Reclaimed missing-film placeholder "${holder.title}" — "${film.title}" is on disk`);
    } else if (confidence === "EXACT") {
      // Two owned rows for one movie, proven by id — safe to merge.
      await prisma.version.updateMany({ where: { filmId: film.id }, data: { filmId: holder.id } });
      await prisma.film.delete({ where: { id: film.id } });
      await prisma.film.update({ where: { id: holder.id }, data: { owned: true } });
      log.push(`Merged duplicate "${film.title}" into "${holder.title}" (tmdb:${tmdbId})`);
      return;
    } else {
      // A search-based match colliding with an owned film is far more likely
      // a WRONG match than a true duplicate — never merge on it.
      log.push(
        `Match conflict: search matched "${film.title}"${film.year ? ` (${film.year})` : ""} to "${holder.title}" (tmdb:${tmdbId}), which is already in the library — left unmatched for review`
      );
      return;
    }
  }

  // The film must own its tmdbId BEFORE collection parts are processed —
  // otherwise ensureCollection creates a missing-film placeholder for this
  // very film and the update below trips the tmdbId unique constraint.
  try {
    await prisma.film.update({ where: { id: film.id }, data: updateData });
  } catch {
    // Most likely a unique constraint clash on imdbId backfill — retry without it.
    delete updateData.imdbId;
    await prisma.film.update({ where: { id: film.id }, data: updateData });
  }

  if (details.belongs_to_collection) {
    await ensureCollection(details.belongs_to_collection, collectionCache, log);
    await prisma.film.update({
      where: { id: film.id },
      data: { collectionId: details.belongs_to_collection.id },
    });
  }

  await cachePoster(details.poster_path, "w342");
  await cachePoster(details.backdrop_path, "w780");
}

// --- TV ---

// Same exact-normalised-title-with-year-tolerance preference as pickHit()
// above, adapted to /search/tv's field names (name / first_air_date).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickTvHit(results: any[] | undefined, title: string, year: number | null): any {
  if (!results?.length) return undefined;
  const want = normalizeTitle(title);
  const yearOk = (r: { first_air_date?: string }) =>
    !year || !r.first_air_date || Math.abs(Number(r.first_air_date.slice(0, 4)) - year) <= 1;
  return results.slice(0, 5).find((r) => normalizeTitle(r.name ?? "") === want && yearOk(r)) ?? results[0];
}

/**
 * Upsert one season's ShowSeason row plus every Episode in its TMDB manifest
 * (name/overview/stillPath/airDate/runtimeMins). `owned` is NEVER touched
 * here — absent episodes are created with owned=false, and existing rows
 * (owned=true from the scanner, or owned=false from a prior enrich) keep
 * whatever the scanner last set. episode_number is the identity throughout;
 * nothing here reorders by air date (DVD-order rips like Firefly depend on
 * that).
 */
// This library is disc rips, so when TMDB carries a DVD episode group
// (type 3) for a show, THAT ordering is our episode numbering — e.g. Firefly,
// where TMDB's default season is air order ("The Train Job" first) but the
// discs (and these files) put "Serenity" at E01. Verified live: the group's
// per-entry `order` is the disc position.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDvdEpisodeOrder(tmdbId: number, showTitle: string, log: string[]): Promise<Map<number, any[]> | null> {
  try {
    const groups = await tmdbFetch(`/tv/${tmdbId}/episode_groups`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dvd = (groups.results as any[] | undefined)?.find((g) => g.type === 3);
    if (!dvd) return null;
    const detail = await tmdbFetch(`/tv/episode_group/${dvd.id}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manifest = new Map<number, any[]>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const entry of ((detail.groups as any[]) ?? [])) {
      // Only literal "Season N" entries count — DVD groups also carry
      // "Specials"/bonus-disc entries (Firefly has 9 making-of docs) that
      // must never be mistaken for a season.
      const m = /^season\s*(\d+)$/i.exec((entry.name ?? "").trim());
      if (!m) continue;
      const seasonNumber = Number(m[1]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eps = [...(((entry.episodes as any[]) ?? []))].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (eps.length) manifest.set(seasonNumber, eps);
    }
    if (manifest.size === 0) return null;
    log.push(`Using DVD episode order for "${showTitle}" (TMDB group "${dvd.name}")`);
    return manifest;
  } catch {
    return null; // best-effort — default (air) order applies
  }
}

async function enrichSeason(
  showId: number,
  tmdbId: number,
  seasonNumber: number,
  log: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overrideEpisodes?: any[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const season: any = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);

  const showSeason = await prisma.showSeason.upsert({
    where: { showId_seasonNumber: { showId, seasonNumber } },
    create: {
      showId,
      seasonNumber,
      name: season.name ?? null,
      overview: season.overview ?? null,
      posterPath: season.poster_path ?? null,
      airDate: season.air_date ? new Date(season.air_date) : null,
    },
    update: {
      name: season.name ?? null,
      overview: season.overview ?? null,
      posterPath: season.poster_path ?? null,
      airDate: season.air_date ? new Date(season.air_date) : null,
    },
  });
  await cachePoster(season.poster_path, "w342");

  // In DVD-order mode the group's disc position IS the episode number; the
  // default path trusts TMDB's own episode_number.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const episodeList: any[] = overrideEpisodes ?? ((season.episodes as any[]) ?? []);
  for (let i = 0; i < episodeList.length; i++) {
    const ep = episodeList[i];
    const episodeNumber = overrideEpisodes ? i + 1 : ep.episode_number;
    if (episodeNumber == null) continue;

    await prisma.episode.upsert({
      where: { seasonId_episodeNumber: { seasonId: showSeason.id, episodeNumber } },
      create: {
        seasonId: showSeason.id,
        episodeNumber,
        name: ep.name ?? null,
        overview: ep.overview ?? null,
        stillPath: ep.still_path ?? null,
        airDate: ep.air_date ? new Date(ep.air_date) : null,
        runtimeMins: ep.runtime ?? null,
        // owned defaults false — flipped to true only by the scanner.
      },
      update: {
        name: ep.name ?? null,
        overview: ep.overview ?? null,
        stillPath: ep.still_path ?? null,
        airDate: ep.air_date ? new Date(ep.air_date) : null,
        runtimeMins: ep.runtime ?? null,
        // owned intentionally omitted — never touched by enrichment.
      },
    });
    await cachePoster(ep.still_path, "w300");
  }

  if (!overrideEpisodes && !season.episodes) {
    log.push(`Season ${seasonNumber} manifest for tmdb:${tmdbId} had no episode list`);
  }
}

async function enrichOneShow(show: Show, log: string[]): Promise<void> {
  let tmdbId: number | null = null;
  let confidence: "SEARCH" | "LOW" = "SEARCH";

  const yearParams: Record<string, string> = show.year ? { first_air_date_year: String(show.year) } : {};
  let hit = pickTvHit((await tmdbFetch("/search/tv", { query: show.title, ...yearParams })).results, show.title, show.year);
  if (hit) {
    confidence = "SEARCH";
  } else if (show.year) {
    hit = pickTvHit((await tmdbFetch("/search/tv", { query: show.title })).results, show.title, show.year);
    if (hit) confidence = "LOW";
  }
  if (!hit && normalizeTitle(show.title) !== show.title.toLowerCase()) {
    // Accented/punctuated titles can miss — retry with the stripped form.
    hit = pickTvHit(
      (await tmdbFetch("/search/tv", { query: normalizeTitle(show.title), ...yearParams })).results,
      show.title,
      show.year,
    );
    if (hit) confidence = "LOW";
  }
  if (hit) tmdbId = hit.id;

  if (tmdbId == null) {
    log.push(`No TMDB match for "${show.title}"${show.year ? ` (${show.year})` : ""}`);
    return;
  }

  const details = await tmdbFetch(`/tv/${tmdbId}`, { append_to_response: "external_ids" });

  if (confidence === "LOW") {
    log.push(`Low-confidence match: "${show.title}"${show.year ? ` (${show.year})` : ""} -> "${details.name}" (tmdb:${tmdbId})`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {
    tmdbId,
    overview: details.overview ?? null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
    firstAirDate: details.first_air_date ? new Date(details.first_air_date) : null,
    status: details.status ?? null,
    rating: details.vote_average ?? null,
    genres: details.genres?.length ? details.genres.map((g: { name: string }) => g.name).join(", ") : null,
    matchConfidence: confidence,
  };

  // Filename-derived year wins when present; backfill from TMDB otherwise.
  if (!show.year && details.first_air_date) updateData.year = Number(details.first_air_date.slice(0, 4));
  if (details.external_ids?.imdb_id) updateData.imdbId = details.external_ids.imdb_id;

  // Another Show row may already hold this tmdbId — a search-based match
  // colliding with an existing show is far more likely a WRONG match than a
  // true duplicate (no TV equivalent of the movie-collection reclaim case,
  // since Shows aren't created as TMDB-manifest placeholders) — never merge
  // destructively on it, mirroring enrichOneFilm's caution for movies.
  const holder = await prisma.show.findUnique({ where: { tmdbId } });
  if (holder && holder.id !== show.id) {
    log.push(
      `Match conflict: search matched "${show.title}"${show.year ? ` (${show.year})` : ""} to "${holder.title}" (tmdb:${tmdbId}), which is already in the library — left unmatched for review`,
    );
    return;
  }

  try {
    await prisma.show.update({ where: { id: show.id }, data: updateData });
  } catch {
    // Most likely a unique constraint clash on imdbId backfill — retry without it.
    delete updateData.imdbId;
    await prisma.show.update({ where: { id: show.id }, data: updateData });
  }

  await cachePoster(details.poster_path, "w342");
  await cachePoster(details.backdrop_path, "w780");

  const dvdOrder = await fetchDvdEpisodeOrder(tmdbId, show.title, log);

  const numberOfSeasons: number = details.number_of_seasons ?? 0;
  for (let seasonNumber = 1; seasonNumber <= numberOfSeasons; seasonNumber++) {
    try {
      await enrichSeason(show.id, tmdbId, seasonNumber, log, dvdOrder?.get(seasonNumber));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to fetch season ${seasonNumber} for "${show.title}": ${message}`);
    }
  }
}

async function doEnrich(runId: number): Promise<void> {
  const log: string[] = [];

  const films = await prisma.film.findMany({
    where: { matchConfidence: { in: ["UNMATCHED", "LOW"] } },
    orderBy: [{ owned: "desc" }, { id: "asc" }],
  });

  const shows = await prisma.show.findMany({
    where: { matchConfidence: { in: ["UNMATCHED", "LOW"] } },
    orderBy: [{ id: "asc" }],
  });

  const total = films.length + shows.length;
  await updateProgress(runId, {
    total,
    filesSeen: 0,
    progress: 0,
    message: `Enriching ${films.length} film(s), ${shows.length} show(s)`,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collectionCache = new Map<number, any>();
  let completed = 0;

  for (const film of films) {
    try {
      await enrichOneFilm(film, log, collectionCache);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to enrich "${film.title}": ${message}`);
    }
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, {
        progress: completed,
        filesSeen: completed,
        message: `Enriched ${completed}/${total}: ${film.title}`,
      });
    }
  }

  for (const show of shows) {
    try {
      await enrichOneShow(show, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to enrich "${show.title}": ${message}`);
    }
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, {
        progress: completed,
        filesSeen: completed,
        message: `Enriched ${completed}/${total}: ${show.title}`,
      });
    }
  }

  await finishRun(runId, log, `Enriched ${films.length} film(s), ${shows.length} show(s)`);
}

/**
 * Kick off enrichment. Resolves quickly once the run is registered (or an
 * existing run is found, or the run is failed immediately for a missing API
 * key) — the actual TMDB work continues in the background and is not
 * awaited here.
 */
export async function runEnrich(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("ENRICH");
  if (!started) return { runId: run.id, started: false };

  if (!process.env.TMDB_API_KEY) {
    await failRun(run.id, new Error("TMDB_API_KEY not set"));
    return { runId: run.id, started: true };
  }

  doEnrich(run.id).catch(async (err) => {
    console.error("[tmdb] enrich failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[tmdb] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}
