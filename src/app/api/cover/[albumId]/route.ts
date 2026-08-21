// Serves cached album cover art, e.g. /api/cover/42. Unlike /api/poster
// (which receives the cache-relative path directly, since that IS the TMDB
// path), this route only receives the numeric Album id, so it looks up
// Album.coverPath first — covers are fetched/cached during enrichment
// (src/lib/musicbrainz.ts + src/lib/cover-art.ts), not on demand here.
// Rejects any resolved path that would land outside the covers cache dir.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.resolve(POSTER_CACHE_DIR, "covers");

export async function GET(_req: NextRequest, ctx: { params: Promise<{ albumId: string }> }) {
  const { albumId: albumIdParam } = await ctx.params;
  const albumId = Number(albumIdParam);
  if (!Number.isInteger(albumId)) {
    return NextResponse.json({ error: "invalid album id" }, { status: 400 });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { coverPath: true } });
  if (!album?.coverPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const dest = path.resolve(COVERS_DIR, album.coverPath);
  if (dest !== COVERS_DIR && !dest.startsWith(COVERS_DIR + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(dest);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
