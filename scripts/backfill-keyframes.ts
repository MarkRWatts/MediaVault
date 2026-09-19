// One-off backfill for KeyframeIndex (V4_PLAN.md "Keyframe index") — every
// probed film Version and EpisodeFile that has no fresh cached index yet.
// Cues-only by default, same as the scanner hook (scanner.ts); pass
// --ffprobe to also run the whole-file ffprobe fallback for anything with
// no usable Cues (an MKV muxed without them, or a non-Matroska container) —
// slow, since it reads every packet of every such file, so it's opt-in
// rather than the default for a run over the whole library.
//
// Idempotent: a file whose cached index already matches its current
// mtime/size is left alone.
//
//   npx tsx scripts/backfill-keyframes.ts
//   npx tsx scripts/backfill-keyframes.ts --ffprobe
//   docker compose exec app npx tsx scripts/backfill-keyframes.ts --ffprobe

import "dotenv/config";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getCuesKeyframes, getKeyframes, type KeyframesResult } from "@/lib/playback/keyframes";
import { loadKeyframeIndex, saveKeyframeIndex, type KeyframeKind } from "@/lib/playback/keyframe-store";

const useFfprobe = process.argv.slice(2).includes("--ffprobe");

interface Summary {
  cues: number;
  ffprobe: number;
  noIndex: number;
  errors: number;
  alreadyFresh: number;
}

async function resolveKeyframes(absPath: string): Promise<KeyframesResult | null> {
  if (useFfprobe) return getKeyframes(absPath);
  const cues = await getCuesKeyframes(absPath);
  return cues ? { keyframeSecs: cues.keyframeSecs, source: "cues" } : null;
}

async function backfillOne(
  kind: KeyframeKind,
  fileId: number,
  relPath: string,
  root: string,
  mtimeMs: number,
  sizeBytes: bigint,
  summary: Summary,
): Promise<void> {
  const cacheKey = { mtimeMs, sizeBytes };
  const cached = await loadKeyframeIndex(kind, fileId, cacheKey);
  if (cached) {
    summary.alreadyFresh++;
    return;
  }

  const absPath = path.resolve(root, relPath);
  try {
    const result = await resolveKeyframes(absPath);
    if (!result) {
      summary.noIndex++;
      console.log(`  no index: ${relPath}`);
      return;
    }
    await saveKeyframeIndex(kind, fileId, cacheKey, result);
    summary[result.source]++;
    console.log(`  ${result.source} (${result.keyframeSecs.length}): ${relPath}`);
  } catch (err) {
    summary.errors++;
    console.log(`  ! ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log(`keyframe backfill${useFfprobe ? " (ffprobe fallback enabled)" : " (cues only — pass --ffprobe for the rest)"}`);
  const summary: Summary = { cues: 0, ffprobe: 0, noIndex: 0, errors: 0, alreadyFresh: 0 };

  const moviesPath = process.env.MOVIES_PATH;
  if (moviesPath) {
    const versions = await prisma.version.findMany({
      where: { probedAt: { not: null }, mtimeMs: { not: null }, sizeBytes: { not: null } },
      select: { id: true, filePath: true, mtimeMs: true, sizeBytes: true },
      orderBy: { id: "asc" },
    });
    console.log(`${versions.length} probed film version(s)`);
    for (const v of versions) {
      await backfillOne("film", v.id, v.filePath, moviesPath, v.mtimeMs!, v.sizeBytes!, summary);
    }
  } else {
    console.log("MOVIES_PATH is not set — skipping film versions");
  }

  const tvShowsPath = process.env.TVSHOWS_PATH;
  if (tvShowsPath) {
    const episodeFiles = await prisma.episodeFile.findMany({
      where: { probedAt: { not: null }, mtimeMs: { not: null }, sizeBytes: { not: null } },
      select: { id: true, filePath: true, mtimeMs: true, sizeBytes: true },
      orderBy: { id: "asc" },
    });
    console.log(`${episodeFiles.length} probed episode file(s)`);
    for (const f of episodeFiles) {
      await backfillOne("episode", f.id, f.filePath, tvShowsPath, f.mtimeMs!, f.sizeBytes!, summary);
    }
  } else {
    console.log("TVSHOWS_PATH is not set — skipping episode files");
  }

  console.log(
    `\ncues: ${summary.cues}, ffprobe: ${summary.ffprobe}, no index: ${summary.noIndex}, errors: ${summary.errors}, already fresh: ${summary.alreadyFresh}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
