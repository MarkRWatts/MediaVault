// Persistent, cross-device worklist of scanned-but-not-yet-added barcodes
// (see ScanQueueItem in prisma/schema.prisma). GET lists everything; POST
// adds a barcode (idempotent — re-adding an already-queued barcode just
// returns the existing row rather than duplicating it).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeBarcode } from "@/lib/musicbrainz";
import { shapeScanQueueItem } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

const MEDIA_TYPES = new Set(["auto", "film", "album"]);

export async function GET() {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const items = await prisma.scanQueueItem.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ items: items.map(shapeScanQueueItem) });
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

  const barcode = normalizeBarcode(typeof body.barcode === "string" ? body.barcode : "");
  if (!barcode) {
    return NextResponse.json({ error: "expected a valid UPC/EAN barcode" }, { status: 400 });
  }
  const mediaType = typeof body.mediaType === "string" && MEDIA_TYPES.has(body.mediaType) ? body.mediaType : "auto";

  const existing = await prisma.scanQueueItem.findUnique({ where: { barcode } });
  if (existing) {
    return NextResponse.json(shapeScanQueueItem(existing));
  }

  const created = await prisma.scanQueueItem.create({ data: { barcode, mediaType } });
  return NextResponse.json(shapeScanQueueItem(created));
}
