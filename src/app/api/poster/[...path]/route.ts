// Serves cached poster/backdrop images, e.g. /api/poster/w342/abc123.jpg.
// Downloads + caches from TMDB on first request if TMDB_API_KEY is set and
// the file isn't already on disk. Rejects any path that would resolve
// outside POSTER_CACHE_DIR.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cacheRoot = path.resolve(POSTER_CACHE_DIR);
  const dest = path.resolve(cacheRoot, ...segments);

  // Reject path traversal — the resolved path must stay inside the cache dir.
  if (dest !== cacheRoot && !dest.startsWith(cacheRoot + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(dest);
  } catch {
    buf = null;
  }

  if (!buf) {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const tmdbPath = segments.map(encodeURIComponent).join("/");
    try {
      const res = await fetch(`${TMDB_IMAGE_BASE}/${tmdbPath}`);
      if (!res.ok) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
    } catch (err) {
      console.error("[api/poster] fetch/cache failed:", err);
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
