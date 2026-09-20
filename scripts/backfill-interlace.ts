// One-off backfill for InterlaceCheck (V4_PLAN.md "Heads") — the measured
// interlace verdict that resolveInterlaced (src/lib/playback/interlace.ts)
// otherwise fills in lazily, on the first transcoding play of a
// header-interlaced file.
//
// Only header-interlaced files are measured, exactly as the engine does:
// a stream whose `field_order` says progressive (or says nothing) is
// trusted outright and never gets a row, so a full run over a library of
// progressive rips writes almost nothing. The cost is therefore one cheap
// ffprobe per file plus a real `idet` pass over the handful that claim an
// interlaced field order.
//
// Idempotent: a file whose cached measurement already matches its current
// mtime/size is left alone.
//
//   npx tsx scripts/backfill-interlace.ts
//   npx tsx scripts/backfill-interlace.ts --films
//   docker compose exec app npx tsx scripts/backfill-interlace.ts

import "dotenv/config";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";
import { sourceFactsFromProbe } from "@/lib/playback/source";
import { measureInterlace, isMeasuredInterlaced, MIN_SAMPLED_FRAMES } from "@/lib/playback/interlace";
import { loadInterlaceCheck, saveInterlaceCheck } from "@/lib/playback/interlace-store";
import type { MediaKind } from "@/lib/playback/types";

const filmsOnly = process.argv.slice(2).includes("--films");

interface Summary {
  headerProgressive: number;
  interlaced: number;
  progressive: number;
  tooFewFrames: number;
  unmeasurable: number;
  errors: number;
  alreadyFresh: number;
}

async function backfillOne(
  kind: MediaKind,
  fileId: number,
  relPath: string,
  root: string,
  mtimeMs: number,
  sizeBytes: bigint,
  durationSecs: number,
  summary: Summary,
): Promise<void> {
  const absPath = path.resolve(root, relPath);
  const cacheKey = { mtimeMs, sizeBytes };

  try {
    // The header's own claim first — it decides whether measuring is worth
    // anything at all, and it is the cheap half of the work.
    const facts = sourceFactsFromProbe(await probe(absPath));
    if (!facts.interlaced) {
      summary.headerProgressive++;
      return;
    }

    const cached = await loadInterlaceCheck(kind, fileId, cacheKey);
    if (cached) {
      summary.alreadyFresh++;
      console.log(
        `  fresh (${cached.interlacedFrames}/${cached.sampledFrames}, ` +
          `${isMeasuredInterlaced(cached) ? "interlaced" : "progressive"}): ${relPath}`,
      );
      return;
    }

    console.log(`  measuring: ${relPath}`);
    const measured = await measureInterlace(absPath, durationSecs);
    if (!measured) {
      summary.unmeasurable++;
      console.log(`  ! no window could be measured — the engine will fall back to the header: ${relPath}`);
      return;
    }
    if (measured.sampledFrames < MIN_SAMPLED_FRAMES) {
      summary.tooFewFrames++;
      console.log(
        `  ! only ${measured.sampledFrames} frame(s) sampled, under the ${MIN_SAMPLED_FRAMES} minimum — ` +
          `not cached, the engine will fall back to the header: ${relPath}`,
      );
      return;
    }

    await saveInterlaceCheck(kind, fileId, cacheKey, measured);
    const verdict = isMeasuredInterlaced(measured);
    if (verdict) summary.interlaced++;
    else summary.progressive++;
    const pct = ((measured.interlacedFrames / measured.sampledFrames) * 100).toFixed(1);
    console.log(
      `  ${verdict ? "INTERLACED" : "progressive"} (${measured.interlacedFrames}/${measured.sampledFrames}, ${pct}%): ${relPath}`,
    );
  } catch (err) {
    summary.errors++;
    console.log(`  ! ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log("interlace backfill — header-interlaced files only (the engine trusts a progressive header outright)");
  const summary: Summary = {
    headerProgressive: 0,
    interlaced: 0,
    progressive: 0,
    tooFewFrames: 0,
    unmeasurable: 0,
    errors: 0,
    alreadyFresh: 0,
  };

  const moviesPath = process.env.MOVIES_PATH;
  if (moviesPath) {
    const versions = await prisma.version.findMany({
      where: {
        probedAt: { not: null },
        mtimeMs: { not: null },
        sizeBytes: { not: null },
        durationSecs: { not: null },
      },
      select: { id: true, filePath: true, mtimeMs: true, sizeBytes: true, durationSecs: true },
      orderBy: { id: "asc" },
    });
    console.log(`${versions.length} probed film version(s)`);
    for (const v of versions) {
      await backfillOne("film", v.id, v.filePath, moviesPath, v.mtimeMs!, v.sizeBytes!, v.durationSecs!, summary);
    }
  } else {
    console.log("MOVIES_PATH is not set — skipping film versions");
  }

  const tvShowsPath = process.env.TVSHOWS_PATH;
  if (!filmsOnly && tvShowsPath) {
    const episodeFiles = await prisma.episodeFile.findMany({
      where: {
        probedAt: { not: null },
        mtimeMs: { not: null },
        sizeBytes: { not: null },
        durationSecs: { not: null },
      },
      select: { id: true, filePath: true, mtimeMs: true, sizeBytes: true, durationSecs: true },
      orderBy: { id: "asc" },
    });
    console.log(`${episodeFiles.length} probed episode file(s)`);
    for (const f of episodeFiles) {
      await backfillOne("episode", f.id, f.filePath, tvShowsPath, f.mtimeMs!, f.sizeBytes!, f.durationSecs!, summary);
    }
  } else if (!filmsOnly) {
    console.log("TVSHOWS_PATH is not set — skipping episode files");
  }

  console.log(
    `\nheader progressive (not measured): ${summary.headerProgressive}` +
      `\nmeasured interlaced: ${summary.interlaced}` +
      `\nmeasured progressive: ${summary.progressive}` +
      `\ntoo few frames: ${summary.tooFewFrames}, unmeasurable: ${summary.unmeasurable}` +
      `\nerrors: ${summary.errors}, already fresh: ${summary.alreadyFresh}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
