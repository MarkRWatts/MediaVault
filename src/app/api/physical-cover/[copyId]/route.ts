// Serves cached cover art for one specific pressing (PhysicalCopy), e.g.
// /api/physical-cover/17 — a vinyl reissue can have different cover art than
// the CD it shares an Album row with, so this is keyed by PhysicalCopy.id
// rather than Album.id. Mirrors /api/cover/[albumId]/route.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.resolve(POSTER_CACHE_DIR, "covers");

export async function GET(_req: NextRequest, ctx: { params: Promise<{ copyId: string }> }) {
  const { copyId: copyIdParam } = await ctx.params;
  const copyId = Number(copyIdParam);
  if (!Number.isInteger(copyId)) {
    return NextResponse.json({ error: "invalid physical copy id" }, { status: 400 });
  }

  const copy = await prisma.physicalCopy.findUnique({ where: { id: copyId }, select: { coverPath: true } });
  if (!copy?.coverPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const dest = path.resolve(COVERS_DIR, copy.coverPath);
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
