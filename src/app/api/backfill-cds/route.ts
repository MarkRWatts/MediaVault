// One-shot CD/source backfill: POST creates an inferred PhysicalCopy(medium:
// "CD") for every digitally-owned album whose tracks are ALL ALAC — per Mark,
// every all-ALAC album in the library is a rip of a CD he physically owns —
// and stamps Album.digitalSource for the two cases that can be safely
// inferred: all-ALAC => "cd", any FairPlay-DRM track => "itunes" (DRM files
// only ever came from the iTunes Store). Everything else (AAC/MP3/FLAC
// without DRM) is a purchase or download of unknowable origin and is
// returned in the `review` list for manual tagging via POST
// /api/digital-source (and POST /api/physical for the physical side).
//
// Idempotent-additive: re-running only adds missing rows / fills null
// sources, never deletes or overwrites hand-set values. Invoked manually
// via curl like the other ops endpoints — not part of any scan/enrich run.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST() {
  const albums = await prisma.album.findMany({
    where: { owned: true },
    select: {
      id: true,
      title: true,
      digitalSource: true,
      artist: { select: { name: true } },
      tracks: { select: { codec: true } },
      physicalCopies: { select: { medium: true } },
    },
  });

  const created: { id: number; artist: string; title: string }[] = [];
  const review: { id: number; artist: string; title: string; codecs: string[] }[] = [];
  let sourcesSet = 0;

  for (const album of albums) {
    const codecs = Array.from(new Set(album.tracks.map((t) => t.codec ?? "unknown"))).sort();
    const allAlac = album.tracks.length > 0 && codecs.length === 1 && codecs[0] === "alac";
    const hasDrm = codecs.includes("drm");

    if (allAlac && !album.physicalCopies.some((c) => c.medium === "CD")) {
      await prisma.physicalCopy.create({
        data: { albumId: album.id, medium: "CD", format: "CD", inferred: true },
      });
      created.push({ id: album.id, artist: album.artist.name, title: album.title });
    }

    if (album.digitalSource === null) {
      const inferredSource = allAlac ? "cd" : hasDrm ? "itunes" : null;
      if (inferredSource) {
        await prisma.album.update({ where: { id: album.id }, data: { digitalSource: inferredSource } });
        sourcesSet++;
      } else if (album.tracks.length > 0) {
        review.push({ id: album.id, artist: album.artist.name, title: album.title, codecs });
      }
    }
  }

  return NextResponse.json({ created: created.length, createdAlbums: created, sourcesSet, review });
}
