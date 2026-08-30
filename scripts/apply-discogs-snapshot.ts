// One-off migration tooling: apply a JSON snapshot produced by
// scripts/export-discogs-snapshot.ts (run against a dev database that's
// already gone through the MusicBrainz-to-Discogs cutover's Enrich Music
// pass) onto THIS database's own Artist/Album rows — so production can pick
// up an already-verified set of Discogs matches without spending its own
// rate-limited Enrich Music run re-deriving the exact same result from
// Discogs a second time.
//
// Usage (after deploying the cutover's code AND running its Prisma
// migration, but BEFORE ever running Enrich Music on this database):
//   npx tsx scripts/apply-discogs-snapshot.ts <path-to-snapshot.json>
//
// Matches rows by stable natural keys (artist folder; owned-album folder;
// placeholder-album normalized title), not row ids, since dev/prod ids can
// differ freely. UPDATEs Discogs identity fields on rows it can match, and
// CREATEs a new placeholder Album row for a snapshot placeholder this
// database doesn't have yet (mirroring reconcileArtistAlbums's own
// placeholder-creation shape) — but deliberately never DELETEs anything:
// a placeholder this database has that the snapshot doesn't mention just
// stays (a harmless, later-tidied cosmetic gap — see this file's own
// STALE_PLACEHOLDERS log at the end), since silently removing a row on
// production over a natural-key mismatch is a strictly worse failure mode
// than leaving one extra placeholder in place. A real Enrich Music run
// on production later reconciles this fully if wanted; it isn't required.
//
// Skips (and logs) anything it can't safely match rather than guessing: a
// missing artist/album folder means this database's library differs from
// the snapshot's at that point, and a Discogs identity already claimed by
// a DIFFERENT row here is left alone rather than fought over — same
// holder-conflict caution reconcileArtistAlbums itself uses.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { sortTitle } from "@/lib/parse";
import { normalizeAlbumTitle } from "@/lib/discogs";

interface ArtistSnapshot {
  folder: string;
  discogsId: number | null;
  matchConfidence: string;
  studioTotal: number | null;
}

interface AlbumSnapshot {
  artistFolder: string;
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

interface Snapshot {
  exportedAt: string;
  artists: ArtistSnapshot[];
  albums: AlbumSnapshot[];
}

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  throw new Error("Usage: npx tsx scripts/apply-discogs-snapshot.ts <path-to-snapshot.json>");
}

// A Discogs identity (master or release id) already claimed by a DIFFERENT
// row than the one we're about to write it to — same holder-conflict shape
// findAlbumByDiscogsIdentity's callers already guard against.
async function identityHeldByOther(
  albumId: number,
  discogsMasterId: number | null,
  discogsReleaseId: number | null,
): Promise<boolean> {
  if (discogsMasterId == null && discogsReleaseId == null) return false;
  const holder = await prisma.album.findFirst({
    where: {
      id: { not: albumId },
      OR: [
        ...(discogsMasterId != null ? [{ discogsMasterId }] : []),
        ...(discogsReleaseId != null ? [{ discogsReleaseId }] : []),
      ],
    },
    select: { id: true, title: true },
  });
  return holder != null;
}

async function main() {
  const raw = await readFile(snapshotPath, "utf-8");
  const snapshot: Snapshot = JSON.parse(raw);
  console.log(`Applying snapshot exported ${snapshot.exportedAt} (${snapshot.artists.length} artist(s), ${snapshot.albums.length} album(s)).`);

  let artistsUpdated = 0;
  let artistsSkipped = 0;
  for (const a of snapshot.artists) {
    const target = await prisma.artist.findUnique({ where: { folder: a.folder } });
    if (!target) {
      console.log(`SKIP artist "${a.folder}" — no matching folder on this database.`);
      artistsSkipped++;
      continue;
    }
    if (a.discogsId != null) {
      const holder = await prisma.artist.findFirst({ where: { discogsId: a.discogsId, id: { not: target.id } } });
      if (holder) {
        console.log(`SKIP artist "${a.folder}" — Discogs artist ${a.discogsId} already claimed by "${holder.name}" here.`);
        artistsSkipped++;
        continue;
      }
    }
    await prisma.artist.update({
      where: { id: target.id },
      data: { discogsId: a.discogsId, matchConfidence: a.matchConfidence, studioTotal: a.studioTotal },
    });
    artistsUpdated++;
  }

  let albumsUpdated = 0;
  let albumsCreated = 0;
  let albumsSkipped = 0;
  for (const al of snapshot.albums) {
    const artist = await prisma.artist.findUnique({ where: { folder: al.artistFolder } });
    if (!artist) {
      console.log(`SKIP album "${al.title}" — artist folder "${al.artistFolder}" not found here.`);
      albumsSkipped++;
      continue;
    }

    const releaseDate = al.releaseDate ? new Date(al.releaseDate) : null;
    const identityData = { discogsMasterId: al.discogsMasterId, discogsReleaseId: al.discogsReleaseId, discogsUrl: al.discogsUrl };

    if (al.albumFolder != null) {
      // Owned album — matched by its own unique (artistId, folder).
      const target = await prisma.album.findUnique({
        where: { artistId_folder: { artistId: artist.id, folder: al.albumFolder } },
      });
      if (!target) {
        console.log(`SKIP owned album "${al.title}" (${al.artistFolder}) — folder "${al.albumFolder}" not found here.`);
        albumsSkipped++;
        continue;
      }
      if (await identityHeldByOther(target.id, al.discogsMasterId, al.discogsReleaseId)) {
        console.log(`SKIP owned album "${al.title}" (${al.artistFolder}) — Discogs identity already claimed by a different album here.`);
        albumsSkipped++;
        continue;
      }
      await prisma.album.update({
        where: { id: target.id },
        data: { ...identityData, year: al.year, releaseDate, kind: al.kind },
      });
      albumsUpdated++;
      continue;
    }

    // Placeholder (owned=false, folder=null) — matched by normalized title
    // among this artist's own placeholders, since folder can't disambiguate.
    // Same normalizeAlbumTitle the export computed al.normalizedTitle with,
    // so a title that only differs by case/punctuation/an ordinal "(N)" tag
    // still matches instead of spawning a duplicate placeholder.
    const candidates = await prisma.album.findMany({ where: { artistId: artist.id, owned: false } });
    const target = candidates.find((c) => normalizeAlbumTitle(c.title) === al.normalizedTitle);

    if (target) {
      if (await identityHeldByOther(target.id, al.discogsMasterId, al.discogsReleaseId)) {
        console.log(`SKIP placeholder "${al.title}" (${al.artistFolder}) — Discogs identity already claimed by a different album here.`);
        albumsSkipped++;
        continue;
      }
      await prisma.album.update({
        where: { id: target.id },
        data: { ...identityData, year: al.year, releaseDate, kind: al.kind },
      });
      albumsUpdated++;
    } else {
      if (await identityHeldByOther(-1, al.discogsMasterId, al.discogsReleaseId)) {
        console.log(`SKIP creating placeholder "${al.title}" (${al.artistFolder}) — Discogs identity already claimed by a different album here.`);
        albumsSkipped++;
        continue;
      }
      await prisma.album.create({
        data: {
          artistId: artist.id,
          title: al.title,
          sortTitle: sortTitle(al.title),
          year: al.year,
          releaseDate,
          ...identityData,
          kind: al.kind,
          owned: false,
          folder: null,
        },
      });
      albumsCreated++;
    }
  }

  console.log(
    `\nDone. Artists: ${artistsUpdated} updated, ${artistsSkipped} skipped. Albums: ${albumsUpdated} updated, ${albumsCreated} created, ${albumsSkipped} skipped.`,
  );
  console.log(
    "No rows were deleted — a placeholder this database has that the snapshot didn't mention is left in place; a real Enrich Music run later will reconcile it if you want.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
