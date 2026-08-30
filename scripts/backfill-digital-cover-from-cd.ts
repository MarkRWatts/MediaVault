// One-off backfill: an all-ALAC album's digital files are a rip of the CD
// physically owned (see attach-cd-discogs-releases.ts's identical premise),
// so once that CD copy has its own Discogs-sourced cover art, the album's
// own (digital) cover art can be upgraded to the same image — useful for
// albums enriched before the Discogs cutover (PR #13), whose digital cover
// is still whatever the old MusicBrainz/Cover Art Archive pipeline cached
// (coverSource "caa"), often a much smaller image than what Discogs now
// serves for the linked CD pressing.
//
// Deliberately narrower than "every all-ALAC album with a CD cover": an
// "embedded" coverSource means the art came out of the ripped files
// themselves — see cover-art.ts's header comment, "the owner hand-curated
// these via iTunes, so for anything on disk this beats any online source"
// — and is left untouched here, since overwriting it with a CD pressing's
// (possibly different edition's) scan would be a downgrade of the app's own
// top-priority source, not an upgrade. Only "caa" and "itunes" (both online
// fetches, not owner-curated) are eligible; "manual" is never touched.
//
// Idempotent: after running once, the album's own coverSource becomes
// "discogs", so a second run's `sourceFilter` no longer matches it.
//
// Usage:
//   npx tsx scripts/backfill-digital-cover-from-cd.ts --dry-run
//   npx tsx scripts/backfill-digital-cover-from-cd.ts [--limit=20]

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.resolve(POSTER_CACHE_DIR, "covers");

const SOURCE_FILTER = new Set(["caa", "itunes"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

async function main() {
  const albums = await prisma.album.findMany({
    where: { owned: true },
    select: {
      id: true,
      title: true,
      coverPath: true,
      coverSource: true,
      artist: { select: { name: true } },
      tracks: { select: { codec: true } },
      physicalCopies: { where: { medium: "CD" }, select: { id: true, coverPath: true } },
    },
  });

  let processed = 0;
  let updated = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const album of albums) {
    if (processed >= limit) break;

    const codecs = Array.from(new Set(album.tracks.map((t) => t.codec ?? "unknown")));
    const allAlac = album.tracks.length > 0 && codecs.length === 1 && codecs[0] === "alac";
    if (!allAlac) continue;

    const cd = album.physicalCopies.find((c) => c.coverPath != null);
    if (!cd?.coverPath) continue;
    if (!SOURCE_FILTER.has(album.coverSource ?? "")) continue;

    const label = `${album.artist.name} — ${album.title}`;
    processed++;

    if (dryRun) {
      console.log(`[dry-run] would replace ${label}'s cover (${album.coverSource}) with the CD's (${cd.coverPath})`);
      continue;
    }

    try {
      const destFileName = `${album.id}.jpg`;
      await fs.copyFile(path.join(COVERS_DIR, cd.coverPath), path.join(COVERS_DIR, destFileName));
      await prisma.album.update({
        where: { id: album.id },
        data: { coverPath: destFileName, coverSource: "discogs" },
      });
      updated++;
      console.log(`✓ ${label}`);
    } catch (err) {
      failed++;
      failures.push(label);
      console.log(`✗ ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${dryRun ? "would process" : "processed"}: ${processed}`);
  if (!dryRun) {
    console.log(`updated: ${updated}, failed: ${failed}`);
    if (failures.length) console.log("failures:", failures);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
