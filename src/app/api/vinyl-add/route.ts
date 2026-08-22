// Add a vinyl-only album: POST { mb, format?, catalogNo?, label?, pressYear?,
// condition?, notes? } where `mb` is a musicbrainz.org release or
// release-group URL (or bare release-group UUID). Creates the Artist/Album
// rows if they don't exist yet (for LPs with no digital rip at all) and
// attaches a VinylCopy. See createVinylOnlyAlbum in src/lib/musicbrainz.ts.

import { NextRequest, NextResponse } from "next/server";
import { createVinylOnlyAlbum, type VinylFields } from "@/lib/musicbrainz";

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

  const vinyl: VinylFields = {
    format: typeof body.format === "string" ? body.format : undefined,
    catalogNo: typeof body.catalogNo === "string" ? body.catalogNo : undefined,
    label: typeof body.label === "string" ? body.label : undefined,
    pressYear: Number.isInteger(body.pressYear) ? body.pressYear : undefined,
    condition: typeof body.condition === "string" ? body.condition : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
  };

  const result = await createVinylOnlyAlbum(mb, vinyl);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
