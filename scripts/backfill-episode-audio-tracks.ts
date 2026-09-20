// One-off backfill for EpisodeAudioTrack, added on 2026-09-20 so TV pages can
// draw the same Dolby/DTS marks the film pages draw. Until then the scanner
// probed each episode file's audio and kept only the rendered string in
// EpisodeFile.audioSummary, so the structure has to be recovered by probing
// again. Re-probes only files that have no tracks on record, writes the tracks
// and refreshes audioSummary (which gains the Atmos / DTS:X segment). No full
// rescan, nothing else touched. Idempotent; safe to re-run.
//
// Usage (locally, or on the VM inside the container):
//   npx tsx scripts/backfill-episode-audio-tracks.ts
//   docker compose exec app npx tsx scripts/backfill-episode-audio-tracks.ts
//
// Needs TVSHOWS_PATH and either ffprobe on PATH or FFPROBE_DOCKER_IMAGE, the
// same as the scanner.

import "dotenv/config";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";
import { buildAudioSummary } from "@/lib/scanner";

async function main(): Promise<void> {
  const root = process.env.TVSHOWS_PATH;
  if (!root) throw new Error("TVSHOWS_PATH is not set");

  const files = await prisma.episodeFile.findMany({
    where: { audioTracks: { none: {} } },
    select: { id: true, filePath: true },
    orderBy: { id: "asc" },
  });

  // A file covering several episodes has one row per episode, all sharing a
  // path — probe it once and write the tracks to every row.
  const byPath = new Map<string, number[]>();
  for (const f of files) byPath.set(f.filePath, [...(byPath.get(f.filePath) ?? []), f.id]);
  console.log(`${files.length} episode file row(s) without tracks, ${byPath.size} distinct file(s)`);

  let probed = 0;
  let written = 0;
  let silent = 0;
  let failed = 0;
  for (const [filePath, ids] of byPath) {
    const absPath = path.resolve(root, filePath);
    let result;
    try {
      result = await probe(absPath);
    } catch (err) {
      failed++;
      console.log(`  ! ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    probed++;
    if (result.audioTracks.length === 0) {
      // Nothing to write, and no tracks means this file stays in the query's
      // result set on every later run. Worth naming rather than looking like
      // a silent no-op.
      silent++;
      console.log(`  - ${filePath}: no audio streams`);
      continue;
    }
    await prisma.episodeAudioTrack.createMany({
      data: ids.flatMap((episodeFileId) =>
        result.audioTracks.map((a) => ({
          episodeFileId,
          streamIdx: a.streamIdx,
          codec: a.codec,
          profile: a.profile,
          language: a.language,
          channels: a.channels,
          layout: a.layout,
          title: a.title,
          isDefault: a.isDefault,
          isDescriptive: a.isDescriptive,
        })),
      ),
    });
    await prisma.episodeFile.updateMany({
      where: { id: { in: ids } },
      data: { audioSummary: buildAudioSummary(result.audioTracks) },
    });
    written += ids.length;
    console.log(`  ${filePath}: ${result.audioTracks.length} track(s) -> ${ids.length} row(s)`);
  }
  console.log(
    `probed ${probed}, wrote tracks for ${written} row(s), ${silent} file(s) with no audio, ${failed} failed`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
