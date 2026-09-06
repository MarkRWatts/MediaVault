// Manage a PhysicalCopy row for an album you already own in the digital
// library. POST with no `id` creates a NEW copy (multiple copies of the same
// medium are legal — an original pressing and a later reissue, say); POST
// with an `id` edits that copy in place. DELETE removes one copy by `id`.
// Album must already exist in the digital library.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PhysicalFields, PhysicalMedium, physicalCopyData, attachPhysicalRelease, normalizeBarcode } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { MAX_NOTES_LENGTH, MAX_TEXT_LENGTH, readTextFields } from "@/lib/validation";

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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  }
  const id = Number.isSafeInteger(body.id) ? (body.id as number) : null;

  // Extract copy fields with defensive typing and length caps (the schema's
  // columns are unbounded text; this is the only backstop).
  const text = readTextFields(body, {
    format: MAX_TEXT_LENGTH,
    catalogNo: MAX_TEXT_LENGTH,
    label: MAX_TEXT_LENGTH,
    condition: MAX_TEXT_LENGTH,
    notes: MAX_NOTES_LENGTH,
    barcode: 64,
    discogsRef: 512,
  });
  if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });

  const fields: PhysicalFields = {};
  if (text.values.format !== undefined) fields.format = text.values.format;
  if (Number.isSafeInteger(body.discs)) fields.discs = body.discs as number;
  if (text.values.catalogNo !== undefined) fields.catalogNo = text.values.catalogNo;
  if (text.values.label !== undefined) fields.label = text.values.label;
  if (Number.isSafeInteger(body.pressYear)) fields.pressYear = body.pressYear as number;
  if (text.values.condition !== undefined) fields.condition = text.values.condition;
  if (text.values.notes !== undefined) fields.notes = text.values.notes;
  // Stored in the same digits-only form the scanner's lookups query by
  // (normalizeBarcode), or a barcode saved with spaces never matches a later
  // scan. An empty string still means "clear it".
  if (text.values.barcode !== undefined) {
    const raw = text.values.barcode.trim();
    if (raw === "") {
      fields.barcode = "";
    } else {
      const normalized = normalizeBarcode(raw);
      if (!normalized) return NextResponse.json({ error: "barcode must be 8, 12, 13 or 14 digits" }, { status: 400 });
      fields.barcode = normalized;
    }
  }

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
  const discogsRef = (text.values.discogsRef ?? "").trim();
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
