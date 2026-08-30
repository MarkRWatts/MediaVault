// One-off backfill: reconcileArtistAlbums (src/lib/discogs.ts) previously set
// an album's Discogs identity (discogsMasterId/discogsReleaseId) without also
// storing its discogsUrl — that field was only ever written by the manual
// "fix incorrect match" and pressing-link paths. The URL is fully derivable
// from the identity already on the row, so this needs no Discogs API calls:
// it just fills in the gap for every album whose identity is set but whose
// discogsUrl is still null.
//
// Usage: npx tsx scripts/backfill-album-discogs-url.ts

import { prisma } from "@/lib/db";

async function main() {
  const rows = await prisma.album.findMany({
    where: {
      discogsUrl: null,
      OR: [{ discogsMasterId: { not: null } }, { discogsReleaseId: { not: null } }],
    },
    select: { id: true, title: true, discogsMasterId: true, discogsReleaseId: true },
  });

  console.log(`${rows.length} album(s) missing discogsUrl despite having an identity`);

  for (const a of rows) {
    const discogsUrl =
      a.discogsMasterId != null
        ? `https://www.discogs.com/master/${a.discogsMasterId}`
        : `https://www.discogs.com/release/${a.discogsReleaseId}`;
    await prisma.album.update({ where: { id: a.id }, data: { discogsUrl } });
    console.log(`  "${a.title}" -> ${discogsUrl}`);
  }

  console.log("done");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
