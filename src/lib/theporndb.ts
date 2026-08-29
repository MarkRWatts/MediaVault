// ThePornDB (metadatapi.net) enrichment: match Scene rows, pull
// title/date/studio/performers, cache artwork. Mirrors musicbrainz.ts's
// shape (fixed-interval rate limiter + one retry on transient failure, not
// tmdb.ts's flat post-call sleep) since TPDB — unlike TMDB — has a real
// documented rate cap. API shape confirmed against the official
// ThePornDatabase/Jellyfin.Plugin.ThePornDB C# client source, and the
// matching heuristic below was spot-checked live against this app's own
// library before being written (see ADULT_PLAN.md, local-only).
// Degrades gracefully with no THEPORNDB_API_KEY.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { normalizeTitle, sortTitle, VIDEO_EXTENSIONS } from "@/lib/parse";
import type { Scene } from "@/generated/prisma/client";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";

const TPDB_BASE = "https://api.theporndb.net";
const IMAGE_CACHE_DIR = process.env.ADULT_IMAGE_CACHE_DIR ?? "./data/adult-images";
// Confirmed in the official Jellyfin plugin's own rate limiter
// (TimeLimiter.GetFromMaxCountByInterval(120, 60s)) — not a guessed figure.
// A fixed-interval clock, same reasoning as musicbrainz.ts: TMDB has no
// stated hard cap, TPDB does, so a scheduler beats a flat sleep here.
const MIN_INTERVAL_MS = 500; // ~120/min, comfortably under the confirmed cap
const RETRY_BACKOFF_MS = 3000;
const PROGRESS_UPDATE_EVERY = 3;
const HASH_CHUNK_BYTES = 64 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tpdbFetch(pathname: string, params: Record<string, string> = {}): Promise<any> {
  const key = process.env.THEPORNDB_API_KEY;
  if (!key) throw new Error("THEPORNDB_API_KEY not set");

  const url = new URL(`${TPDB_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new Error(`ThePornDB ${pathname} -> ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return res.json();
    if (attempt === 0 && isTransientStatus(res.status)) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`ThePornDB ${pathname} -> HTTP ${res.status}`);
  }
}

/** OpenSubtitles-style hash: filesize + a wrapping 64-bit sum of 8-byte
 *  little-endian words from the first and last 64KB of the file (read
 *  directly, no ffprobe needed). Smaller files use what they have for both
 *  ends, same as the reference algorithm. Passed to TPDB as `hash=` for an
 *  exact-file match independent of filename. */
export async function computeOshash(absPath: string): Promise<string> {
  const stat = await fs.stat(absPath);
  const size = stat.size;
  const handle = await fs.open(absPath, "r");
  try {
    let hash = BigInt(size);
    const mask = BigInt("0xFFFFFFFFFFFFFFFF"); // wraps the sum at 64 bits

    const sumChunk = async (position: number): Promise<void> => {
      const len = Math.min(HASH_CHUNK_BYTES, size);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, position);
      for (let i = 0; i + 8 <= len; i += 8) {
        hash = (hash + buf.readBigUInt64LE(i)) & mask;
      }
    };

    await sumChunk(0);
    if (size > HASH_CHUNK_BYTES) await sumChunk(Math.max(0, size - HASH_CHUNK_BYTES));

    return hash.toString(16).padStart(16, "0");
  } finally {
    await handle.close();
  }
}

/** Aggressive noise-stripping tailored to what TPDB's `parse` endpoint
 *  actually needs — confirmed live that raw filenames (resolution tags,
 *  extensions, track-number prefixes, repeated SITE.COM branding) return
 *  zero results, but the same titles cleaned of just that noise match
 *  correctly. Prefixing with the studio-folder hint mirrors the exact
 *  queries that were spot-checked successfully. */
export function cleanTitleForSearch(fileName: string, folder: string | null): string {
  let s = fileName;
  // Strip a (possibly doubled) trailing video extension.
  for (let guard = 0; guard < 3; guard++) {
    const ext = path.extname(s).slice(1).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) break;
    s = s.slice(0, -(ext.length + 1));
  }
  s = s.replace(/^\d+\s*-\s*/, ""); // leading "NNN - " track prefix
  s = s.replace(/\b\d{3,4}p?\s*(HD|SD)?\b/gi, ""); // "1080p", "1080 HD", "720p"…
  s = s.replace(/\b(UHD|4K|HD|SD)\b/gi, ""); // standalone quality tokens
  s = s.replace(/\b[\w-]+\.(COM|NET|ME|TV|XXX)\b/gi, ""); // "FROLICME.COM", "site.me"
  s = s.replace(/\bWWW\.\S+/gi, "");
  s = s.replace(/[-–—]+$/g, "").replace(/^[-–—]+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return folder ? `${folder} ${s}`.trim() : s;
}

async function cacheImage(url: string | null | undefined, kind: "scenes" | "performers" | "studios", id: string | number): Promise<string | null> {
  if (!url) return null;
  const rel = `${kind}/${id}.jpg`;
  const dest = path.join(IMAGE_CACHE_DIR, rel);

  try {
    await fs.access(dest);
    return rel;
  } catch {
    // fall through and download
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    return rel;
  } catch {
    return null; // best-effort, same posture as tmdb.ts's cachePoster
  }
}

async function resolveStudio(site: { id: number; name: string; poster?: string | null; logo?: string | null } | null | undefined): Promise<number | null> {
  if (!site) return null;
  const studio = await prisma.studio.upsert({
    where: { tpdbId: site.id },
    create: { tpdbId: site.id, name: site.name },
    update: { name: site.name },
  });
  return studio.id;
}

interface TpdbPerformerRef {
  id: string;
  name: string;
  image?: string | null;
  face?: string | null;
}

async function resolvePerformers(sceneId: number, performers: TpdbPerformerRef[]): Promise<void> {
  const performerIds: number[] = [];
  for (const p of performers) {
    const performer = await prisma.performer.upsert({
      where: { tpdbId: p.id },
      create: { tpdbId: p.id, name: p.name },
      update: { name: p.name },
    });
    if (!performer.imagePath) {
      const cached = await cacheImage(p.image ?? p.face, "performers", performer.tpdbId ?? performer.id);
      if (cached) await prisma.performer.update({ where: { id: performer.id }, data: { imagePath: cached } });
    }
    performerIds.push(performer.id);
  }

  // Reconcile join rows for this pass (delete+recreate), same approach as
  // AudioTrack in scanner.ts's processVersion.
  await prisma.scenePerformer.deleteMany({ where: { sceneId } });
  if (performerIds.length > 0) {
    await prisma.scenePerformer.createMany({
      data: performerIds.map((performerId) => ({ sceneId, performerId })),
    });
  }
}

async function enrichOneScene(scene: Scene, log: string[]): Promise<void> {
  const adultPath = process.env.ADULT_PATH;
  const absPath = adultPath ? path.join(adultPath, scene.filePath) : null;

  let oshash: string | null = null;
  if (absPath) {
    try {
      oshash = await computeOshash(absPath);
    } catch (err) {
      log.push(`Could not hash "${scene.filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const query = cleanTitleForSearch(scene.fileName, scene.folder);
  const searched = await tpdbFetch("/scenes", {
    parse: query,
    hash: oshash ?? "",
    year: "",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let results: any[] = Array.isArray(searched?.data) ? searched.data : [];

  // TPDB's hash param appears to sometimes suppress otherwise-good title
  // matches when the hash doesn't correspond to a known encode (confirmed
  // live: identical title-only query returns a match, adding a real-but-
  // unrecognized oshash zeroes it out) — retry title-only before giving up,
  // so a locally re-encoded file doesn't lose a match it would otherwise get.
  if (results.length === 0 && oshash) {
    const retried = await tpdbFetch("/scenes", { parse: query, hash: "", year: "" });
    results = Array.isArray(retried?.data) ? retried.data : [];
  }

  if (results.length === 0) {
    if (scene.matchConfidence !== "UNMATCHED") {
      await prisma.scene.update({ where: { id: scene.id }, data: { matchConfidence: "UNMATCHED" } });
    }
    log.push(`No ThePornDB match for "${scene.title}"`);
    return;
  }

  let confidence: "EXACT" | "SEARCH" | "LOW" = "SEARCH";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hit: any = null;

  if (oshash) {
    hit = results.find((r) => Array.isArray(r.hashes) && r.hashes.some((h: { hash?: string }) => h.hash === oshash));
    if (hit) confidence = "EXACT";
  }
  if (!hit) {
    const want = normalizeTitle(query);
    hit = results.find((r) => normalizeTitle(r.title ?? "") === want);
    confidence = hit ? "SEARCH" : "LOW";
    hit ??= results[0];
  }

  const studioId = await resolveStudio(hit.site);
  const performers: TpdbPerformerRef[] = Array.isArray(hit.performers) ? hit.performers : [];

  const posterPath = await cacheImage(hit.poster, "scenes", hit.id);
  const backgroundPath = await cacheImage(hit.background ?? hit.background_back, "scenes", `${hit.id}-bg`);

  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      title: hit.title ?? scene.title,
      sortTitle: sortTitle(hit.title ?? scene.title),
      studioId,
      date: hit.date ? new Date(hit.date) : null,
      overview: hit.description ?? null,
      tpdbId: hit.id,
      matchConfidence: confidence,
      ...(posterPath ? { posterPath } : {}),
      ...(backgroundPath ? { backgroundPath } : {}),
    },
  });

  await resolvePerformers(scene.id, performers);

  if (confidence === "LOW") {
    log.push(`Low-confidence match: "${scene.title}" -> "${hit.title}" (tpdb:${hit.id})`);
  }
}

async function doEnrichScenes(runId: number): Promise<void> {
  const log: string[] = [];

  const scenes = await prisma.scene.findMany({
    where: { matchConfidence: { in: ["UNMATCHED", "LOW"] } },
    orderBy: [{ id: "asc" }],
  });

  const total = scenes.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Enriching ${total} scene(s)` });

  let completed = 0;
  for (const scene of scenes) {
    try {
      await enrichOneScene(scene, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to enrich "${scene.title}": ${message}`);
    }
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, {
        progress: completed,
        filesSeen: completed,
        message: `Enriched ${completed}/${total}: ${scene.title}`,
      });
    }
  }

  await finishRun(runId, log, `Enriched ${total} scene(s)`);
}

/**
 * Kick off scene enrichment. Resolves quickly once the run is registered
 * (or an existing run is found, or the run is failed immediately for a
 * missing API key) — the actual ThePornDB work continues in the background
 * and is not awaited here.
 */
export async function runEnrichScene(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("ENRICH_SCENE");
  if (!started) return { runId: run.id, started: false };

  if (!process.env.THEPORNDB_API_KEY) {
    await failRun(run.id, new Error("THEPORNDB_API_KEY not set"));
    return { runId: run.id, started: true };
  }

  doEnrichScenes(run.id).catch(async (err) => {
    console.error("[theporndb] enrich failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[theporndb] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}
