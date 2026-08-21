// Walks MOVIES_PATH, parses filenames, probes files with ffprobe, and upserts
// Film/Version/AudioTrack rows. See PLAN.md "Scanner" and the Film/Version
// identity rules in the schema doc comment.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";
import { parseFileName, filmKey, normalizeTitle, sortTitle, VIDEO_EXTENSIONS, type ParsedFile } from "@/lib/parse";
import { classifyFormat } from "@/lib/constants";
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

async function processVersion(file: CandidateFile, filmId: number, log: string[]): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existing = await prisma.version.findUnique({ where: { filePath: parsed.relPath } });

  const needProbe = !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

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
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    const version = await prisma.version.upsert({
      where: { filePath: parsed.relPath },
      create: {
        ...baseData,
        filePath: parsed.relPath,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
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

async function doScan(runId: number): Promise<void> {
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

  const total = candidates.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Found ${total} video files` });

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
  let completed = 0;
  await mapPool(candidates, PROBE_CONCURRENCY, async (file) => {
    const filmId = filmIdByPath.get(file.parsed.relPath)!;
    await processVersion(file, filmId, log);
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, {
        progress: completed,
        filesSeen: completed,
        message: `Probed ${completed}/${total}: ${file.parsed.fileName}`,
      });
    }
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

  await finishRun(runId, log, `Scanned ${total} files`);
}

/**
 * Kick off a scan. Resolves quickly once the run is registered (or an
 * existing run is found) — the actual walk/probe/upsert work continues in
 * the background and is not awaited here.
 */
export async function runScan(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("SCAN");
  if (!started) return { runId: run.id, started: false };

  doScan(run.id).catch(async (err) => {
    console.error("[scanner] scan failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[scanner] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}
