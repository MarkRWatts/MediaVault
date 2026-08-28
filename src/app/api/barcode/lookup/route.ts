// Resolve a scanned/typed barcode to "already owned" or a not-owned
// candidate to add — the single-scan page's interactive lookup. See
// src/lib/scan-resolve.ts for the actual resolution logic (shared with the
// persistent scan queue's processor) and its header comment for why the
// music/movie paths run concurrently and what `type` skips.

import { NextRequest, NextResponse } from "next/server";
import { normalizeBarcode } from "@/lib/musicbrainz";
import { resolveBarcode } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

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

  const type = body.type === "film" || body.type === "album" ? body.type : null;
  const result = await resolveBarcode(barcode, type);
  return NextResponse.json(result);
}
