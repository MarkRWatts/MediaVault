// Walks MOVIES_PATH, parses filenames, probes files with ffprobe, and upserts
// Film/Version/AudioTrack rows. See PLAN.md "Scanner" and the Film/Version
// identity rules in the schema doc comment.

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe, type ProbedAudioTrack } from "@/lib/ffprobe";
import { parseFileName, filmKey, normalizeTitle, sortTitle, VIDEO_EXTENSIONS, type ParsedFile } from "@/lib/parse";
import { parseEpisodePath, type ParsedEpisodeFile } from "@/lib/parse-tv";
import { classifyFormat } from "@/lib/constants";
import { audioBadge } from "@/lib/audio";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";

const MAX_DEPTH = 3;
const PROBE_CONCURRENCY = 3;
const PROGRESS_UPDATE_EVERY = 3;

interface CandidateFile {
  parsed: ParsedFile;
  absPath: string;
  size: number;
  mtimeMs: number;
}

async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than fail the whole scan
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(root, abs, depth + 1, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) out.push(path.relative(root, abs));
    }
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Resolve (or create) the Film identity for a group of files that share a
 * filmKey. Handles the owned=false → owned=true reconciliation for films
 * that already exist as TMDB-collection placeholders.
 */
async function resolveFilm(representative: ParsedFile, log: string[]): Promise<number> {
  let film = null;

  if (representative.imdbId) {
    film = await prisma.film.findUnique({ where: { imdbId: representative.imdbId } });
  } else if (representative.tmdbId) {
    film = await prisma.film.findUnique({ where: { tmdbId: representative.tmdbId } });
  } else {
    const normTitle = normalizeTitle(representative.title);
    const candidates = await prisma.film.findMany({ where: { owned: true, year: representative.year } });
    film = candidates.find((f) => normalizeTitle(f.title) === normTitle) ?? null;
  }

  if (film) {
    const updates: Record<string, unknown> = {};
    if (!film.owned) {
      updates.owned = true;
      log.push(`Merged "${film.title}"${film.year ? ` (${film.year})` : ""} — was tracked as a missing collection film, found on disk`);
    }
    if (representative.imdbId && !film.imdbId) updates.imdbId = representative.imdbId;
    if (representative.tmdbId && !film.tmdbId) updates.tmdbId = representative.tmdbId;
    if (Object.keys(updates).length > 0) {
      film = await prisma.film.update({ where: { id: film.id }, data: updates });
    }
    return film.id;
  }

  const created = await prisma.film.create({
    data: {
      title: representative.title,
      sortTitle: sortTitle(representative.title),
      year: representative.year,
      imdbId: representative.imdbId,
      tmdbId: representative.tmdbId,
      owned: true,
    },
  });
  return created.id;
}

// Derive Version.videoRange from the probe's HDR signals. Dolby Vision side
// data wins regardless of the base layer's transfer characteristic (most DV
// encodes carry an HDR10-compatible base layer, i.e. smpte2084, alongside
// the DV enhancement layer). Only set when the probe actually succeeded —
// callers should leave videoRange untouched on probe failure.
function deriveVideoRange(colorTransfer: string | null, hasDolbyVision: boolean): string {
  if (hasDolbyVision) return "DOLBY_VISION";
  if (colorTransfer === "smpte2084") return "HDR10";
  if (colorTransfer === "arib-std-b67") return "HLG";
  return "SDR";
}

async function processVersion(
  file: CandidateFile,
  filmId: number,
  log: string[],
  force: boolean,
): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existing = await prisma.version.findUnique({ where: { filePath: parsed.relPath } });

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  const baseData = {
    filmId,
    fileName: parsed.fileName,
    edition: parsed.edition,
    container: parsed.container || null,
  };

  if (!needProbe) {
    await prisma.version.update({ where: { filePath: parsed.relPath }, data: baseData });
    return;
  }

  try {
    const result = await probe(absPath);
    const format = classifyFormat(result.width);
    const videoRange = deriveVideoRange(result.colorTransfer, result.hasDolbyVision);
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    const version = await prisma.version.upsert({
      where: { filePath: parsed.relPath },
      create: {
        ...baseData,
        filePath: parsed.relPath,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
      update: {
        ...baseData,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
    });

    await prisma.audioTrack.deleteMany({ where: { versionId: version.id } });
    if (result.audioTracks.length > 0) {
      await prisma.audioTrack.createMany({
        data: result.audioTracks.map((t) => ({
          versionId: version.id,
          streamIdx: t.streamIdx,
          codec: t.codec,
          profile: t.profile,
          language: t.language,
          channels: t.channels,
          layout: t.layout,
          title: t.title,
        })),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${parsed.relPath}": ${message}`);
    const fallbackFormat = (parsed.resolutionTag ?? 0) >= 720 ? "BLURAY" : "UNKNOWN";
    await prisma.version.upsert({
      where: { filePath: parsed.relPath },
      create: { ...baseData, filePath: parsed.relPath, format: fallbackFormat },
      update: { ...baseData, format: existing?.format && existing.format !== "UNKNOWN" ? existing.format : fallbackFormat },
    });
  }
}

// --- TV ---

interface TvCandidate {
  parsed: ParsedEpisodeFile;
  absPath: string;
  size: number;
  mtimeMs: number;
}

// Fields written to an EpisodeFile row, excluding the (filePath, episodeId)
// identity — shared shape between the cache-hit (fileName/container only)
// and freshly-probed update paths.
interface EpisodeFileData {
  fileName: string;
  container: string | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  videoRange?: string;
  durationSecs?: number | null;
  sizeBytes?: bigint;
  mtimeMs?: number;
  format?: string;
  audioSummary?: string | null;
  probedAt?: Date;
}

// Build the human-readable audio track summary stored on EpisodeFile, e.g.
// "DTS-HD MA · 5.1 · ENG; Dolby Digital · Stereo · ENG" — reuses the same
// audioBadge() labelling the movie UI uses for Version audio tracks.
function buildAudioSummary(tracks: ProbedAudioTrack[]): string | null {
  if (tracks.length === 0) return null;
  return tracks
    .map((t) => {
      const { label, sublabel } = audioBadge(t.codec, t.profile, t.channels, t.layout);
      const parts = [label];
      if (sublabel) parts.push(sublabel);
      if (t.language) parts.push(t.language.toUpperCase());
      return parts.join(" · ");
    })
    .join("; ");
}

/** Resolve (or create) the Show identity for a top-level TV folder. Title,
 * sortTitle, and year come from the folder name; TMDB enrichment fills in
 * the rest later and is never touched here. */
async function resolveShow(showFolder: string, title: string, year: number | null): Promise<number> {
  const show = await prisma.show.upsert({
    where: { folder: showFolder },
    create: { folder: showFolder, title, sortTitle: sortTitle(title), year },
    update: { title, sortTitle: sortTitle(title), year },
  });
  return show.id;
}

async function resolveSeason(showId: number, seasonNumber: number): Promise<number> {
  const season = await prisma.showSeason.upsert({
    where: { showId_seasonNumber: { showId, seasonNumber } },
    create: { showId, seasonNumber },
    update: {},
  });
  return season.id;
}

/** Resolve (or create) an owned Episode. Only ever touches `owned` — name,
 * overview, stillPath, airDate, runtimeMins are TMDB manifest data. */
async function resolveEpisode(seasonId: number, episodeNumber: number): Promise<number> {
  const episode = await prisma.episode.upsert({
    where: { seasonId_episodeNumber: { seasonId, episodeNumber } },
    create: { seasonId, episodeNumber, owned: true },
    update: { owned: true },
  });
  return episode.id;
}

/**
 * Probe (or skip, per the mtime+size cache) one TV file and upsert an
 * EpisodeFile row for each episode it covers — more than one for a
 * multi-episode range file (S01E01-E02): same filePath, one row per
 * episodeId, kept in sync with identical probe data.
 */
async function processEpisodeFile(
  file: TvCandidate,
  episodeIds: number[],
  log: string[],
  force: boolean,
): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existingRows = await prisma.episodeFile.findMany({ where: { filePath: parsed.relPath } });
  const existing = existingRows[0];

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  const baseData: EpisodeFileData = {
    fileName: parsed.fileName,
    container: parsed.container || null,
  };

  const upsertAll = async (data: EpisodeFileData) => {
    for (const episodeId of episodeIds) {
      await prisma.episodeFile.upsert({
        where: { filePath_episodeId: { filePath: parsed.relPath, episodeId } },
        create: { ...data, filePath: parsed.relPath, episodeId },
        update: data,
      });
    }
  };

  if (!needProbe) {
    await upsertAll(baseData);
    return;
  }

  try {
    const result = await probe(absPath);
    const format = classifyFormat(result.width);
    const videoRange = deriveVideoRange(result.colorTransfer, result.hasDolbyVision);
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    await upsertAll({
      ...baseData,
      width: result.width,
      height: result.height,
      videoCodec: result.videoCodec,
      videoRange,
      durationSecs: result.durationSecs,
      sizeBytes,
      mtimeMs,
      format,
      audioSummary: buildAudioSummary(result.audioTracks),
      probedAt: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${parsed.relPath}": ${message}`);
    const fallbackFormat = existing?.format && existing.format !== "UNKNOWN" ? existing.format : "UNKNOWN";
    await upsertAll({ ...baseData, format: fallbackFormat });
  }
}

async function doScan(runId: number, force: boolean): Promise<void> {
  const log: string[] = [];
  const moviesPath = process.env.MOVIES_PATH;
  if (!moviesPath) throw new Error("MOVIES_PATH is not set");

  const relPaths: string[] = [];
  await walk(moviesPath, moviesPath, 0, relPaths);

  const candidates: CandidateFile[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(moviesPath, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseFileName(relPath);
    if (parsed.year == null) log.push(`No year parsed for "${relPath}"`);
    candidates.push({ parsed, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // TV discovery happens up front too, so the run's total reflects both
  // phases from the start. TVSHOWS_PATH is optional — when unset, the TV
  // phase is skipped entirely (nothing is touched, nothing is deleted).
  const tvShowsPath = process.env.TVSHOWS_PATH;
  const tvRelPaths: string[] = [];
  if (tvShowsPath) await walk(tvShowsPath, tvShowsPath, 0, tvRelPaths);
  else log.push("TVSHOWS_PATH not set — skipping TV scan");

  const tvCandidates: TvCandidate[] = [];
  let tvUnparsed = 0;
  for (const relPath of tvRelPaths) {
    const absPath = path.join(tvShowsPath!, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseEpisodePath(relPath);
    if (!parsed) {
      tvUnparsed++;
      log.push(`Could not parse episode info from "${relPath}"`);
      continue;
    }
    tvCandidates.push({ parsed, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const movieTotal = candidates.length;
  const tvTotal = tvCandidates.length;
  const total = movieTotal + tvTotal;
  await updateProgress(runId, {
    total,
    filesSeen: 0,
    progress: 0,
    message: `Found ${movieTotal} movie file(s), ${tvTotal} TV episode file(s)${tvUnparsed ? ` (${tvUnparsed} unparsed)` : ""}`,
  });

  let overallCompleted = 0;
  async function reportProgress(message: string): Promise<void> {
    overallCompleted++;
    if (overallCompleted % PROGRESS_UPDATE_EVERY === 0 || overallCompleted === total) {
      await updateProgress(runId, { progress: overallCompleted, filesSeen: overallCompleted, message });
    }
  }

  // ---- Movies ----

  // Group by filmKey and resolve Film identity for each group up front.
  const groups = new Map<string, CandidateFile[]>();
  for (const c of candidates) {
    const key = filmKey(c.parsed);
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const filmIdByPath = new Map<string, number>();
  for (const files of groups.values()) {
    const filmId = await resolveFilm(files[0].parsed, log);
    for (const f of files) filmIdByPath.set(f.parsed.relPath, filmId);
  }

  // Probe + upsert versions, bounded concurrency (SMB share).
  await mapPool(candidates, PROBE_CONCURRENCY, async (file) => {
    const filmId = filmIdByPath.get(file.parsed.relPath)!;
    await processVersion(file, filmId, log, force);
    await reportProgress(`Probed ${overallCompleted}/${total}: ${file.parsed.fileName}`);
  });

  // Delete Version rows for files no longer on disk.
  const seenPaths = new Set(candidates.map((c) => c.parsed.relPath));
  const allVersions = await prisma.version.findMany({ select: { id: true, filePath: true } });
  const staleVersionIds = allVersions.filter((v) => !seenPaths.has(v.filePath)).map((v) => v.id);
  if (staleVersionIds.length > 0) {
    await prisma.version.deleteMany({ where: { id: { in: staleVersionIds } } });
    log.push(`Removed ${staleVersionIds.length} version(s) for files no longer on disk`);
  }

  // Owned films left with zero versions: drop, unless they're collection
  // members (revert to a "missing" placeholder instead).
  const emptyOwnedFilms = await prisma.film.findMany({
    where: { owned: true, versions: { none: {} } },
    select: { id: true, title: true, collectionId: true },
  });
  for (const f of emptyOwnedFilms) {
    if (f.collectionId != null) {
      await prisma.film.update({ where: { id: f.id }, data: { owned: false } });
      log.push(`"${f.title}" has no versions left — reverted to missing (still a collection member)`);
    } else {
      await prisma.film.delete({ where: { id: f.id } });
      log.push(`Deleted "${f.title}" — no versions left`);
    }
  }

  // ---- TV ----

  if (tvShowsPath) {
    // Resolve Show/Season/Episode identities up front, serially (like
    // resolveFilm above) — cheap and keeps the concurrent probe phase free of
    // upsert races on the same Show/ShowSeason row.
    const showIdByFolder = new Map<string, number>();
    const seasonIdByKey = new Map<string, number>();
    const episodeIdsByPath = new Map<string, number[]>();

    for (const c of tvCandidates) {
      const { parsed } = c;
      let showId = showIdByFolder.get(parsed.showFolder);
      if (showId === undefined) {
        showId = await resolveShow(parsed.showFolder, parsed.showTitle, parsed.showYear);
        showIdByFolder.set(parsed.showFolder, showId);
      }
      const seasonKey = `${showId}:${parsed.season}`;
      let seasonId = seasonIdByKey.get(seasonKey);
      if (seasonId === undefined) {
        seasonId = await resolveSeason(showId, parsed.season);
        seasonIdByKey.set(seasonKey, seasonId);
      }
      const episodeIds: number[] = [];
      for (const epNum of parsed.episodes) {
        episodeIds.push(await resolveEpisode(seasonId, epNum));
      }
      episodeIdsByPath.set(parsed.relPath, episodeIds);
    }

    // Probe + upsert episode files, bounded concurrency (SMB share).
    await mapPool(tvCandidates, PROBE_CONCURRENCY, async (file) => {
      const episodeIds = episodeIdsByPath.get(file.parsed.relPath)!;
      await processEpisodeFile(file, episodeIds, log, force);
      await reportProgress(`Probed ${overallCompleted}/${total}: ${file.parsed.fileName}`);
    });

    // Delete EpisodeFile rows for TV files no longer on disk.
    const seenTvPaths = new Set(tvCandidates.map((c) => c.parsed.relPath));
    const allEpisodeFiles = await prisma.episodeFile.findMany({ select: { id: true, filePath: true } });
    const staleEpisodeFileIds = allEpisodeFiles.filter((f) => !seenTvPaths.has(f.filePath)).map((f) => f.id);
    if (staleEpisodeFileIds.length > 0) {
      await prisma.episodeFile.deleteMany({ where: { id: { in: staleEpisodeFileIds } } });
      log.push(`Removed ${staleEpisodeFileIds.length} episode file(s) for TV files no longer on disk`);
    }

    // Owned episodes left with zero files: revert to a TMDB manifest
    // placeholder (owned=false) if the show is TMDB-matched — that row is
    // what the missing-episode report is built from — otherwise drop it.
    const emptyOwnedEpisodes = await prisma.episode.findMany({
      where: { owned: true, files: { none: {} } },
      select: {
        id: true,
        episodeNumber: true,
        season: { select: { seasonNumber: true, show: { select: { title: true, tmdbId: true } } } },
      },
    });
    for (const ep of emptyOwnedEpisodes) {
      const label = `"${ep.season.show.title}" S${ep.season.seasonNumber}E${ep.episodeNumber}`;
      if (ep.season.show.tmdbId != null) {
        await prisma.episode.update({ where: { id: ep.id }, data: { owned: false } });
        log.push(`${label} has no files left — reverted to missing (show is TMDB-matched)`);
      } else {
        await prisma.episode.delete({ where: { id: ep.id } });
        log.push(`Deleted ${label} — no files left, show not TMDB-matched`);
      }
    }

    // Shows whose top-level folder vanished from disk.
    let topEntries: Dirent[] = [];
    try {
      topEntries = await fs.readdir(tvShowsPath, { withFileTypes: true });
    } catch {
      topEntries = [];
    }
    const currentFolders = new Set(
      topEntries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name),
    );
    const allShows = await prisma.show.findMany({ select: { id: true, folder: true, title: true } });
    for (const s of allShows) {
      if (currentFolders.has(s.folder)) continue;
      await prisma.show.delete({ where: { id: s.id } });
      log.push(`Deleted show "${s.title}" — folder "${s.folder}" no longer on disk`);
    }
  }

  await finishRun(runId, log, `Scanned ${movieTotal} movie file(s), ${tvTotal} TV episode file(s)`);

  // Lazy import to avoid a module-load cycle (jellyfin.ts doesn't import
  // scanner.ts, but keeping the coupling one-directional and load-time-free
  // is cheap insurance). Fire-and-forget: a scan shouldn't block on Jellyfin.
  const { jellyfinConfigured, runJellyfinSync } = await import("@/lib/jellyfin");
  if (jellyfinConfigured()) {
    runJellyfinSync().catch((err) => console.error("[scanner] post-scan Jellyfin sync failed to start:", err));
  }
}

/**
 * Kick off a scan. Resolves quickly once the run is registered (or an
 * existing run is found) — the actual walk/probe/upsert work continues in
 * the background and is not awaited here.
 *
 * `force` ignores the size+mtime probe cache and re-probes every file even
 * when nothing on disk changed — used for a one-off re-probe after adding
 * new ffprobe-derived fields (e.g. audio profile, HDR range) so existing
 * rows pick up values that would otherwise stay null forever.
 */
export async function runScan(options: { force?: boolean } = {}): Promise<{ runId: number; started: boolean }> {
  const force = options.force ?? false;
  const { run, started } = await guardAndCreateRun("SCAN");
  if (!started) return { runId: run.id, started: false };

  doScan(run.id, force).catch(async (err) => {
    console.error("[scanner] scan failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[scanner] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}
