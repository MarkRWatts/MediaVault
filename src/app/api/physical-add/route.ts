// Add a physical-only album: POST { discogsUrl, medium?, format?, discs?,
// catalogNo?, label?, pressYear?, condition?, notes? } where `discogsUrl` is
// a discogs.com/release/... or /master/... URL and `medium` is "VINYL"
// (default) or "CD". Creates the Artist/Album rows if they don't exist yet
// (for LPs/CDs with no digital rip at all) and attaches a PhysicalCopy. See
// createPhysicalOnlyAlbum in src/lib/discogs.ts.

import { NextRequest, NextResponse } from "next/server";
import { withLookupSlot } from "@/lib/semaphore";
import { createPhysicalOnlyAlbum, type PhysicalFields, type PhysicalMedium } from "@/lib/discogs";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { MAX_NOTES_LENGTH, MAX_TEXT_LENGTH, readJsonObject, readTextFields } from "@/lib/validation";

async function handlePost(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

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

// Bounded concurrency for owner-driven metadata lookups — see lookupSemaphore.
export const POST = withLookupSlot(handlePost);
