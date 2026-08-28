// Tag a film you already know about as owned on a physical medium (DVD,
// Blu-ray, 4K UHD), independent of whether it's been ripped — the film-side
// equivalent of /api/physical for albums. POST to create/update the copy
// record for one (film, medium) pair, DELETE to remove it.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MEDIA = new Set(["DVD", "BLURAY", "UHD"]);

function parseMedium(value: unknown): string | null {
  const medium = typeof value === "string" ? value.toUpperCase() : "";
  return MEDIA.has(medium) ? medium : null;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const filmId = Number(body.filmId);
  const medium = parseMedium(body.medium);
  if (!Number.isInteger(filmId) || !medium) {
    return NextResponse.json({ error: "expected { filmId: number, medium: 'DVD' | 'BLURAY' | 'UHD' }" }, { status: 400 });
  }

  const film = await prisma.film.findUnique({ where: { id: filmId } });
  if (!film) {
    return NextResponse.json({ error: "unknown film id" }, { status: 404 });
  }

  const notes = typeof body.notes === "string" ? body.notes : undefined;
  const barcode = typeof body.barcode === "string" ? body.barcode : undefined;

  const result = await prisma.filmPhysicalCopy.upsert({
    where: { filmId_medium: { filmId, medium } },
    create: { filmId, medium, notes: notes || null, barcode: barcode || null },
    update: { notes: notes || null, ...(barcode !== undefined ? { barcode: barcode || null } : {}) },
  });

  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
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
      { error: error instanceof Error ? error.message : "unknown error" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
