// Serves cached artist enrichment images, e.g. /api/artist-image/7/photo or
// /api/artist-image/7/backdrop — see src/lib/artist-bio.ts for how these are
// fetched/cached (POSTER_CACHE_DIR/artists/<id>-<kind>.jpg). Mirrors
// /api/cover/[albumId]/route.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const ARTISTS_DIR = path.resolve(POSTER_CACHE_DIR, "artists");

export async function GET(_req: NextRequest, ctx: { params: Promise<{ artistId: string; kind: string }> }) {
  const { artistId: artistIdParam, kind } = await ctx.params;
  const artistId = Number(artistIdParam);
  if (!Number.isInteger(artistId) || (kind !== "photo" && kind !== "backdrop")) {
    return NextResponse.json({ error: "invalid artist id or kind" }, { status: 400 });
  }

  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    select: { photoPath: true, backdropPath: true },
  });
  const relPath = kind === "photo" ? artist?.photoPath : artist?.backdropPath;
  if (!relPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const dest = path.resolve(ARTISTS_DIR, relPath);
  if (dest !== ARTISTS_DIR && !dest.startsWith(ARTISTS_DIR + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let buf: Buffer;
  let stat: { mtimeMs: number; size: number };
  try {
    [buf, stat] = await Promise.all([fs.readFile(dest), fs.stat(dest)]);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

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
