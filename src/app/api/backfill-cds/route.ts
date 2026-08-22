// One-shot CD backfill: POST creates an inferred PhysicalCopy(medium: "CD")
// for every digitally-owned album whose tracks are ALL ALAC — per Mark,
// every all-ALAC album in the library is a rip of a CD he physically owns.
// Anything else (AAC/MP3 = iTunes purchase or lossy download, FLAC =
// download, DRM = iTunes FairPlay) can't be assumed and is returned in the
// `review` list for manual tagging via POST /api/physical instead.
//
// Idempotent-additive: re-running only adds missing rows, never deletes or
// touches existing (including hand-edited) copies. Invoked manually via
// curl like the other ops endpoints — not part of any scan/enrich run.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST() {
  const albums = await prisma.album.findMany({
    where: { owned: true },
    select: {
      id: true,
      title: true,
      artist: { select: { name: true } },
      tracks: { select: { codec: true } },
      physicalCopies: { select: { medium: true } },
    },
  });

  const created: { id: number; artist: string; title: string }[] = [];
  const review: { id: number; artist: string; title: string; codecs: string[] }[] = [];

  for (const album of albums) {
    if (album.physicalCopies.some((c) => c.medium === "CD")) continue; // already tagged
    const codecs = Array.from(new Set(album.tracks.map((t) => t.codec ?? "unknown"))).sort();
    const allAlac = album.tracks.length > 0 && codecs.length === 1 && codecs[0] === "alac";

    if (allAlac) {
      await prisma.physicalCopy.create({
        data: { albumId: album.id, medium: "CD", format: "CD", inferred: true },
      });
      created.push({ id: album.id, artist: album.artist.name, title: album.title });
    } else {
      review.push({ id: album.id, artist: album.artist.name, title: album.title, codecs });
    }
  }

  return NextResponse.json({ created: created.length, createdAlbums: created, review });
}
