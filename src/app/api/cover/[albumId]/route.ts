// Serves cached album cover art, e.g. /api/cover/42. Unlike /api/poster
// (which receives the cache-relative path directly, since that IS the TMDB
// path), this route only receives the numeric Album id, so it looks up
// Album.coverPath first — covers are fetched/cached during enrichment
// (src/lib/discogs.ts + src/lib/cover-art.ts), not on demand here.
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
  let stat: { mtimeMs: number; size: number };
  try {
    [buf, stat] = await Promise.all([fs.readFile(dest), fs.stat(dest)]);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Unlike /api/poster, a cover's bytes CAN change under the same URL (a
  // re-enrichment swaps the cached file in place — e.g. embedded art
  // replacing an online fetch), so `immutable` here left browsers showing
  // stale art for up to a year. Serve with an mtime+size ETag and always
  // revalidate: LAN 304s are cheap, cover swaps show up on the next load.
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (_req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: etag,
    },
  });
}
