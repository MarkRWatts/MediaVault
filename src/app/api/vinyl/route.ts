// Tag an album you already own in the library as also owned on vinyl (or
// remove that tag). POST to create/update a vinyl copy record, DELETE to
// remove it. Album must already exist in the digital library.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { VinylFields, vinylCopyData } from "@/lib/musicbrainz";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const albumId = Number(body.albumId);
  if (!Number.isInteger(albumId)) {
    return NextResponse.json({ error: "expected { albumId: number }" }, { status: 400 });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) {
    return NextResponse.json({ error: "unknown album id" }, { status: 404 });
  }

  // Extract vinyl fields with defensive typing
  const vinylFields: VinylFields = {};
  if (typeof body.format === "string") vinylFields.format = body.format;
  if (typeof body.catalogNo === "string") vinylFields.catalogNo = body.catalogNo;
  if (typeof body.label === "string") vinylFields.label = body.label;
  if (Number.isInteger(body.pressYear)) vinylFields.pressYear = body.pressYear as number;
  if (typeof body.condition === "string") vinylFields.condition = body.condition;
  if (typeof body.notes === "string") vinylFields.notes = body.notes;

  const result = await prisma.vinylCopy.upsert({
    where: { albumId },
    create: { albumId, ...vinylCopyData(vinylFields) },
    update: vinylCopyData(vinylFields),
  });

  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  const albumIdStr = new URL(req.url).searchParams.get("albumId");
  const albumId = Number(albumIdStr);
  if (!Number.isInteger(albumId)) {
    return NextResponse.json({ error: "expected albumId query parameter (integer)" }, { status: 400 });
  }

  try {
    await prisma.vinylCopy.delete({ where: { albumId } });
  } catch (error) {
    // P2025: record not found — idempotent, so we don't error
    if (error instanceof Error && "code" in error && error.code === "P2025") {
      return NextResponse.json({ ok: true });
    }
    // Any other error is unexpected
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
