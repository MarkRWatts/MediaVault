// Add a physical-only album: POST { mb, medium?, format?, discs?, catalogNo?,
// label?, pressYear?, condition?, notes? } where `mb` is a musicbrainz.org
// release or release-group URL (or bare release-group UUID) and `medium` is
// "VINYL" (default) or "CD". Creates the Artist/Album rows if they don't
// exist yet (for LPs/CDs with no digital rip at all) and attaches a
// PhysicalCopy. See createPhysicalOnlyAlbum in src/lib/musicbrainz.ts.

import { NextRequest, NextResponse } from "next/server";
import { createPhysicalOnlyAlbum, type PhysicalFields, type PhysicalMedium } from "@/lib/musicbrainz";

export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const mb = typeof body.mb === "string" ? body.mb : "";
  if (!mb) {
    return NextResponse.json({ error: "expected { mb: string }" }, { status: 400 });
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

  const result = await createPhysicalOnlyAlbum(mb, medium, fields);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
