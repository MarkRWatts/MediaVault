// Resolve a pasted Discogs release URL to "already owned" or a not-owned
// candidate to add — backs the Scan page's "paste Discogs links" bulk-add
// tool. See src/lib/scan-resolve.ts's resolveDiscogsUrl for the actual
// resolution logic (resolves the release's own Discogs identity — its
// master if it has one, otherwise the release itself).

import { NextRequest, NextResponse } from "next/server";
import { withLookupSlot } from "@/lib/semaphore";
import { readJsonObject } from "@/lib/validation";
import { resolveDiscogsUrl } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

async function handlePost(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "expected a Discogs release URL" }, { status: 400 });
  }

  try {
    const result = await resolveDiscogsUrl(url);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Discogs lookup failed" },
      { status: 502 },
    );
  }
}

// Bounded concurrency for owner-driven metadata lookups — see lookupSemaphore.
export const POST = withLookupSlot(handlePost);
