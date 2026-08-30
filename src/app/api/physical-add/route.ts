// Add a physical-only album: POST { discogsUrl, medium?, format?, discs?,
// catalogNo?, label?, pressYear?, condition?, notes? } where `discogsUrl` is
// a discogs.com/release/... or /master/... URL and `medium` is "VINYL"
// (default) or "CD". Creates the Artist/Album rows if they don't exist yet
// (for LPs/CDs with no digital rip at all) and attaches a PhysicalCopy. See
// createPhysicalOnlyAlbum in src/lib/discogs.ts.

import { NextRequest, NextResponse } from "next/server";
import { createPhysicalOnlyAlbum, type PhysicalFields, type PhysicalMedium } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const discogsUrl = typeof body.discogsUrl === "string" ? body.discogsUrl : "";
  if (!discogsUrl) {
    return NextResponse.json({ error: "expected { discogsUrl: string }" }, { status: 400 });
  }

  const rawMedium = typeof body.medium === "string" ? body.medium.toUpperCase() : "VINYL";
  if (rawMedium !== "VINYL" && rawMedium !== "CD") {
    return NextResponse.json({ error: "medium must be 'VINYL' or 'CD'" }, { status: 400 });
  }
  const medium: PhysicalMedium = rawMedium;

  const fields: PhysicalFields = {
    format: typeof body.format === "string" ? body.format : undefined,
    discs: Number.isInteger(body.discs) ? body.discs : undefined,
    catalogNo: typeof body.catalogNo === "string" ? body.catalogNo : undefined,
    label: typeof body.label === "string" ? body.label : undefined,
    pressYear: Number.isInteger(body.pressYear) ? body.pressYear : undefined,
    condition: typeof body.condition === "string" ? body.condition : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
  };

  const result = await createPhysicalOnlyAlbum(discogsUrl, medium, fields);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
