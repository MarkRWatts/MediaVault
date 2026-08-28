// Tag an album you already own in the library as also owned on a physical
// medium (vinyl LP, CD), or remove that tag. POST to create/update the copy
// record for one (album, medium) pair, DELETE to remove it. Album must
// already exist in the digital library.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PhysicalFields, PhysicalMedium, physicalCopyData } from "@/lib/musicbrainz";

function parseMedium(value: unknown): PhysicalMedium | null {
  const medium = typeof value === "string" ? value.toUpperCase() : "";
  return medium === "VINYL" || medium === "CD" ? medium : null;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const albumId = Number(body.albumId);
  const medium = parseMedium(body.medium);
  if (!Number.isInteger(albumId) || !medium) {
    return NextResponse.json({ error: "expected { albumId: number, medium: 'VINYL' | 'CD' }" }, { status: 400 });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) {
    return NextResponse.json({ error: "unknown album id" }, { status: 404 });
  }

  // Extract copy fields with defensive typing
  const fields: PhysicalFields = {};
  if (typeof body.format === "string") fields.format = body.format;
  if (Number.isInteger(body.discs)) fields.discs = body.discs as number;
  if (typeof body.catalogNo === "string") fields.catalogNo = body.catalogNo;
  if (typeof body.label === "string") fields.label = body.label;
  if (Number.isInteger(body.pressYear)) fields.pressYear = body.pressYear as number;
  if (typeof body.condition === "string") fields.condition = body.condition;
  if (typeof body.notes === "string") fields.notes = body.notes;
  if (typeof body.barcode === "string") fields.barcode = body.barcode;

  const result = await prisma.physicalCopy.upsert({
    where: { albumId_medium: { albumId, medium } },
    create: { albumId, medium, ...physicalCopyData(medium, fields) },
    update: physicalCopyData(medium, fields),
  });

  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const albumId = Number(params.get("albumId"));
  const medium = parseMedium(params.get("medium"));
  if (!Number.isInteger(albumId) || !medium) {
    return NextResponse.json(
      { error: "expected albumId (integer) and medium ('VINYL' | 'CD') query parameters" },
      { status: 400 },
    );
  }

  try {
    await prisma.physicalCopy.delete({ where: { albumId_medium: { albumId, medium } } });
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
