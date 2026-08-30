// One-off migration tooling: export every Artist/Album's Discogs-derived
// identity fields (not a full data dump — see scripts/apply-discogs-snapshot.ts's
// header for why) to a JSON file, so a subsequent production deploy of the
// MusicBrainz-to-Discogs cutover can transplant an already-verified dev-run's
// results instead of re-running the same rate-limited Enrich Music pass
// against Discogs a second time.
//
// Usage: npx tsx scripts/export-discogs-snapshot.ts [output-path]
// Defaults to ./discogs-snapshot.json in the current directory.
//
// Keyed by stable natural keys, not row ids (dev and prod ids can differ):
// Artist by its unique folder; owned Album by (artist folder, its own unique
// folder); unowned (placeholder) Album by (artist folder, normalized title)
// since placeholders have folder=null. See apply-discogs-snapshot.ts for how
// these keys are matched back up on the target database.

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { normalizeAlbumTitle } from "@/lib/discogs";

const outputPath = process.argv[2] || "./discogs-snapshot.json";

interface ArtistSnapshot {
  folder: string;
  discogsId: number | null;
  matchConfidence: string;
  studioTotal: number | null;
}

interface AlbumSnapshot {
  artistFolder: string;
  // Exactly one of albumFolder/normalizedTitle identifies the row — see
  // this file's header comment.
  albumFolder: string | null;
  normalizedTitle: string | null;
  title: string;
  owned: boolean;
  year: number | null;
  releaseDate: string | null;
  kind: string;
  discogsMasterId: number | null;
  discogsReleaseId: number | null;
  discogsUrl: string | null;
}

async function main() {
  const artists = await prisma.artist.findMany({
    where: { folder: { not: null } },
    select: { folder: true, discogsId: true, matchConfidence: true, studioTotal: true },
  });

  const artistSnapshots: ArtistSnapshot[] = artists.map((a) => ({
    folder: a.folder!,
    discogsId: a.discogsId,
    matchConfidence: a.matchConfidence,
    studioTotal: a.studioTotal,
  }));

  const albums = await prisma.album.findMany({
    where: { artist: { folder: { not: null } } },
    select: {
      title: true,
      owned: true,
      folder: true,
      year: true,
      releaseDate: true,
      kind: true,
      discogsMasterId: true,
      discogsReleaseId: true,
      discogsUrl: true,
      artist: { select: { folder: true } },
    },
  });

  const albumSnapshots: AlbumSnapshot[] = albums.map((a) => ({
    artistFolder: a.artist.folder!,
    albumFolder: a.folder,
    normalizedTitle: a.folder ? null : normalizeAlbumTitle(a.title),
    title: a.title,
    owned: a.owned,
    year: a.year,
    releaseDate: a.releaseDate ? a.releaseDate.toISOString() : null,
    kind: a.kind,
    discogsMasterId: a.discogsMasterId,
    discogsReleaseId: a.discogsReleaseId,
    discogsUrl: a.discogsUrl,
  }));

  const snapshot = {
    exportedAt: new Date().toISOString(),
    artists: artistSnapshots,
    albums: albumSnapshots,
  };

  await writeFile(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(
    `Wrote ${artistSnapshots.length} artist(s) and ${albumSnapshots.length} album(s) (${albumSnapshots.filter((a) => a.owned).length} owned, ${albumSnapshots.filter((a) => !a.owned).length} placeholder) to ${outputPath}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
