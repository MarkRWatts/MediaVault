// Serves cached ThePornDB artwork, e.g. /api/adult-image/scenes/abc123.jpg —
// see src/lib/theporndb.ts's cacheImage. Unlike /api/poster (unauthenticated
// — film artwork isn't sensitive), this route is gated: only fetches
// already-cached files, no live remote fallback (ThePornDB image URLs may be
// signed/expiring, and this must never become an ungated live proxy).
// Rejects any path that would resolve outside ADULT_IMAGE_CACHE_DIR.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

const IMAGE_CACHE_DIR = process.env.ADULT_IMAGE_CACHE_DIR ?? "./data/adult-images";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cacheRoot = path.resolve(IMAGE_CACHE_DIR);
  const dest = path.resolve(cacheRoot, ...segments);

  if (dest !== cacheRoot && !dest.startsWith(cacheRoot + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(dest);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
