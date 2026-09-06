// Resolve a scanned/typed barcode to "already owned" or a not-owned
// candidate to add — the single-scan page's interactive lookup. See
// src/lib/scan-resolve.ts for the actual resolution logic (shared with the
// persistent scan queue's processor) and its header comment for why the
// music/movie paths run concurrently and what `type` skips.

import { NextRequest, NextResponse } from "next/server";
import { withLookupSlot } from "@/lib/semaphore";
import { readJsonObject } from "@/lib/validation";
import { normalizeBarcode } from "@/lib/discogs";
import { resolveBarcode } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

async function handlePost(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const barcode = normalizeBarcode(typeof body.barcode === "string" ? body.barcode : "");
  if (!barcode) {
    return NextResponse.json({ error: "expected a valid UPC/EAN barcode" }, { status: 400 });
  }

  const type = body.type === "film" || body.type === "album" ? body.type : null;
  const result = await resolveBarcode(barcode, type);
  return NextResponse.json(result);
}

// Bounded concurrency for owner-driven metadata lookups — see lookupSemaphore.
export const POST = withLookupSlot(handlePost);
