// GET /api/v1/barcode/:code[?type=film|album] — the MediaVault Scan app's
// one call: is the film, CD or LP in your hand already in the collection?
// Same resolution as the web Scan page's /api/barcode/lookup
// (src/lib/scan-resolve.ts) and the same owner-only gate — it spends the
// Discogs and UPC-lookup quotas — but read-only, typed, and with the
// formats it's already owned in (src/lib/barcode-v1.ts).

import { NextRequest, NextResponse } from "next/server";
import { withLookupSlot } from "@/lib/semaphore";
import { normalizeBarcode } from "@/lib/discogs";
import { resolveBarcode } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { toBarcodeResponse } from "@/lib/barcode-v1";

async function handleGet(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const owner = await requireOwnerOrResponse();
  if (owner instanceof NextResponse) return owner;

  const { code } = await ctx.params;
  const barcode = normalizeBarcode(code);
  if (!barcode) {
    return NextResponse.json({ error: "expected a valid UPC/EAN barcode" }, { status: 400 });
  }

  const typeParam = req.nextUrl.searchParams.get("type");
  const type = typeParam === "film" || typeParam === "album" ? typeParam : null;
  const result = await resolveBarcode(barcode, type);
  return NextResponse.json(await toBarcodeResponse(barcode, result));
}

// Bounded concurrency for owner-driven metadata lookups — see lookupSemaphore.
export const GET = withLookupSlot(handleGet);
