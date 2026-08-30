// One-off backfill: every all-ALAC album in the library is a rip of a CD
// physically owned (see /api/backfill-cds, which already confirmed those
// PhysicalCopy rows — inferred: false — rather than leaving them guessed).
// This script goes one step further: it attaches each such CD copy to the
// SAME Discogs release/master the album itself was already matched to
// (Album.discogsUrl) via attachPhysicalRelease — the same call a human
// makes by pasting a link into "Link a specific pressing" — pulling in that
// pressing's own tracklist/cover, and (see discogs.ts's
// populatePhysicalReleaseFromDiscogs) filling catalogNo/label/pressYear
// only where the copy doesn't already have a hand-entered value.
//
// This does NOT search Discogs for anything new — it only reuses each
// album's own already-vetted identity, so the failure mode is limited to
// "the album's match happens to point at a non-CD pressing" (e.g. a
// master's main_release being a vinyl edition), not a fresh mismatch.
//
// Idempotent: skips any CD copy that already has a discogsReleaseId.
//
// Usage:
//   npx tsx scripts/attach-cd-discogs-releases.ts --dry-run
//   npx tsx scripts/attach-cd-discogs-releases.ts [--limit=20]

import { prisma } from "@/lib/db";
import { attachPhysicalRelease } from "@/lib/discogs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

async function main() {
  const albums = await prisma.album.findMany({
    where: { owned: true, discogsUrl: { not: null } },
    select: {
      id: true,
      title: true,
      discogsUrl: true,
      artist: { select: { name: true } },
      tracks: { select: { codec: true } },
      physicalCopies: { where: { medium: "CD" }, select: { id: true, discogsReleaseId: true } },
    },
  });

  let processed = 0;
  let attached = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const album of albums) {
    if (processed >= limit) break;

    const codecs = Array.from(new Set(album.tracks.map((t) => t.codec ?? "unknown")));
    const allAlac = album.tracks.length > 0 && codecs.length === 1 && codecs[0] === "alac";
    if (!allAlac) continue;

    const cd = album.physicalCopies[0];
    if (!cd || cd.discogsReleaseId != null || !album.discogsUrl) continue;

    const label = `${album.artist.name} — ${album.title}`;
    processed++;

    if (dryRun) {
      console.log(`[dry-run] would attach: ${label} -> ${album.discogsUrl}`);
      continue;
    }

    try {
      const result = await attachPhysicalRelease(cd.id, album.discogsUrl);
      if (result.ok) {
        attached++;
        console.log(`✓ ${label} — ${result.trackCount} track(s)`);
      } else {
        failed++;
        failures.push(label);
        console.log(`✗ ${label} — ${result.error}`);
      }
    } catch (err) {
      failed++;
      failures.push(label);
      console.log(`✗ ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${dryRun ? "would process" : "processed"}: ${processed}`);
  if (!dryRun) {
    console.log(`attached: ${attached}, failed: ${failed}`);
    if (failures.length) console.log("failures:", failures);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
