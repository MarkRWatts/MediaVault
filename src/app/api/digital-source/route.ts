// Set (or clear) the provenance of an album's digital files: POST
// { albumId, source } where source is "cd" | "itunes" | "download" |
// "vinyl-code" | null. "vinyl-code" = a download code bundled with a
// physically-owned LP — pair it with a VINYL copy via POST /api/physical.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DIGITAL_SOURCES } from "@/lib/digital-source";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const albumId = Number(body.albumId);
  const source = body.source === null ? null : typeof body.source === "string" ? body.source : undefined;
  if (
    !Number.isInteger(albumId) ||
    source === undefined ||
    (source !== null && !(DIGITAL_SOURCES as readonly string[]).includes(source))
  ) {
    return NextResponse.json(
      { error: "expected { albumId: number, source: 'cd' | 'itunes' | 'download' | 'vinyl-code' | null }" },
      { status: 400 },
    );
  }

  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) {
    return NextResponse.json({ error: "unknown album id" }, { status: 404 });
  }

  const updated = await prisma.album.update({ where: { id: albumId }, data: { digitalSource: source } });
  return NextResponse.json({ id: updated.id, digitalSource: updated.digitalSource });
}
