// Manage a PhysicalCopy row for an album you already own in the digital
// library. POST with no `id` creates a NEW copy (multiple copies of the same
// medium are legal — an original pressing and a later reissue, say); POST
// with an `id` edits that copy in place. DELETE removes one copy by `id`.
// Album must already exist in the digital library.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PhysicalFields, PhysicalMedium, physicalCopyData, attachPhysicalRelease } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";

function parseMedium(value: unknown): PhysicalMedium | null {
  const medium = typeof value === "string" ? value.toUpperCase() : "";
  return medium === "VINYL" || medium === "CD" ? medium : null;
}

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const id = Number.isInteger(body.id) ? (body.id as number) : null;

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

  let copyId: number;
  let medium: PhysicalMedium;

  if (id != null) {
    // Edit an existing copy in place — medium comes from the row itself,
    // not the request (changing medium isn't supported; remove and re-add).
    const existing = await prisma.physicalCopy.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "unknown physical copy id" }, { status: 404 });
    }
    medium = existing.medium as PhysicalMedium;
    await prisma.physicalCopy.update({ where: { id }, data: physicalCopyData(medium, fields) });
    copyId = id;
  } else {
    const albumId = Number(body.albumId);
    const parsedMedium = parseMedium(body.medium);
    if (!Number.isInteger(albumId) || !parsedMedium) {
      return NextResponse.json({ error: "expected { albumId: number, medium: 'VINYL' | 'CD' }" }, { status: 400 });
    }
    medium = parsedMedium;

    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) {
      return NextResponse.json({ error: "unknown album id" }, { status: 404 });
    }

    const created = await prisma.physicalCopy.create({
      data: { albumId, medium, ...physicalCopyData(medium, fields) },
    });
    copyId = created.id;
  }

  // Optional: link this copy to a specific Discogs release, pulling in its
  // pressing-specific tracklist/cover (see attachPhysicalRelease). Kept
  // separate from the fields above and reported as a non-fatal error — the
  // metadata save above already succeeded either way.
  const discogsRef = typeof body.discogsRef === "string" ? body.discogsRef.trim() : "";
  let trackImportError: string | undefined;
  if (discogsRef) {
    const attached = await attachPhysicalRelease(copyId, discogsRef);
    if (!attached.ok) trackImportError = attached.error;
  }

  const result = await prisma.physicalCopy.findUnique({ where: { id: copyId } });
  return NextResponse.json({ ...result, trackImportError });
}

export async function DELETE(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const params = new URL(req.url).searchParams;
  const id = Number(params.get("id"));
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "expected an id query parameter" }, { status: 400 });
  }

  try {
    await prisma.physicalCopy.delete({ where: { id } });
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
