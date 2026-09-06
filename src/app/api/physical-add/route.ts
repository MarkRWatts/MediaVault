// Add a physical-only album: POST { discogsUrl, medium?, format?, discs?,
// catalogNo?, label?, pressYear?, condition?, notes? } where `discogsUrl` is
// a discogs.com/release/... or /master/... URL and `medium` is "VINYL"
// (default) or "CD". Creates the Artist/Album rows if they don't exist yet
// (for LPs/CDs with no digital rip at all) and attaches a PhysicalCopy. See
// createPhysicalOnlyAlbum in src/lib/discogs.ts.

import { NextRequest, NextResponse } from "next/server";
import { createPhysicalOnlyAlbum, type PhysicalFields, type PhysicalMedium } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { MAX_NOTES_LENGTH, MAX_TEXT_LENGTH, readTextFields } from "@/lib/validation";

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

  const text = readTextFields(body, {
    discogsUrl: 512,
    format: MAX_TEXT_LENGTH,
    catalogNo: MAX_TEXT_LENGTH,
    label: MAX_TEXT_LENGTH,
    condition: MAX_TEXT_LENGTH,
    notes: MAX_NOTES_LENGTH,
  });
  if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });

  const discogsUrl = text.values.discogsUrl ?? "";
  if (!discogsUrl) {
    return NextResponse.json({ error: "expected { discogsUrl: string }" }, { status: 400 });
  }

  const rawMedium = typeof body.medium === "string" ? body.medium.toUpperCase() : "VINYL";
  if (rawMedium !== "VINYL" && rawMedium !== "CD") {
    return NextResponse.json({ error: "medium must be 'VINYL' or 'CD'" }, { status: 400 });
  }
  const medium: PhysicalMedium = rawMedium;

  const fields: PhysicalFields = {
    format: text.values.format,
    discs: Number.isSafeInteger(body.discs) ? (body.discs as number) : undefined,
    catalogNo: text.values.catalogNo,
    label: text.values.label,
    pressYear: Number.isSafeInteger(body.pressYear) ? (body.pressYear as number) : undefined,
    condition: text.values.condition,
    notes: text.values.notes,
  };

  const result = await createPhysicalOnlyAlbum(discogsUrl, medium, fields);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.album);
}
