// TMDB enrichment: match films, pull details + collection membership, cache
// posters/backdrops locally. Degrades gracefully with no TMDB_API_KEY.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { normalizeTitle, sortTitle } from "@/lib/parse";
import type { Film } from "@/generated/prisma/client";
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

async function cachePoster(tmdbPath: string | null | undefined, size: "w342" | "w780"): Promise<void> {
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
async function ensureCollection(collStub: any, collectionCache: Map<number, any>, log: string[]): Promise<void> {
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

async function doEnrich(runId: number): Promise<void> {
  const log: string[] = [];

  const films = await prisma.film.findMany({
    where: { matchConfidence: { in: ["UNMATCHED", "LOW"] } },
    orderBy: [{ owned: "desc" }, { id: "asc" }],
  });

  const total = films.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Enriching ${total} films` });

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

  await finishRun(runId, log, `Enriched ${total} films`);
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
