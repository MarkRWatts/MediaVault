// Tag a film you already know about as owned on a physical medium (DVD,
// Blu-ray, 4K UHD), independent of whether it's been ripped — the film-side
// equivalent of /api/physical for albums. POST to create/update the copy
// record for one (film, medium) pair, DELETE to remove it.

import { NextRequest, NextResponse } from "next/server";
import { hideError } from "@/lib/user-facing-error";
import { prisma } from "@/lib/db";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { normalizeBarcode } from "@/lib/discogs";
import { MAX_NOTES_LENGTH, readJsonObject, readTextFields } from "@/lib/validation";

const MEDIA = new Set(["DVD", "BLURAY", "UHD"]);

function parseMedium(value: unknown): string | null {
  const medium = typeof value === "string" ? value.toUpperCase() : "";
  return MEDIA.has(medium) ? medium : null;
}

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const filmId = Number(body.filmId);
  const medium = parseMedium(body.medium);
  if (!Number.isInteger(filmId) || !medium) {
    return NextResponse.json({ error: "expected { filmId: number, medium: 'DVD' | 'BLURAY' | 'UHD' }" }, { status: 400 });
  }

  const film = await prisma.film.findUnique({ where: { id: filmId } });
  if (!film) {
    return NextResponse.json({ error: "unknown film id" }, { status: 404 });
  }

  const text = readTextFields(body, { notes: MAX_NOTES_LENGTH, barcode: 64 });
  if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });
  const notes = text.values.notes;
  // Digits-only, as the scanner's lookups expect; "" clears it.
  let barcode = text.values.barcode?.trim();
  if (barcode) {
    const normalized = normalizeBarcode(barcode);
    if (!normalized) return NextResponse.json({ error: "barcode must be 8, 12, 13 or 14 digits" }, { status: 400 });
    barcode = normalized;
  }

  const result = await prisma.filmPhysicalCopy.upsert({
    where: { filmId_medium: { filmId, medium } },
    create: { filmId, medium, notes: notes || null, barcode: barcode || null },
    update: { notes: notes || null, ...(barcode !== undefined ? { barcode: barcode || null } : {}) },
  });

  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const params = new URL(req.url).searchParams;
  const filmId = Number(params.get("filmId"));
  const medium = parseMedium(params.get("medium"));
  if (!Number.isInteger(filmId) || !medium) {
    return NextResponse.json(
      { error: "expected filmId (integer) and medium ('DVD' | 'BLURAY' | 'UHD') query parameters" },
      { status: 400 },
    );
  }

  try {
    await prisma.filmPhysicalCopy.delete({ where: { filmId_medium: { filmId, medium } } });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2025") {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { error: hideError(error, "api/film-physical") },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
