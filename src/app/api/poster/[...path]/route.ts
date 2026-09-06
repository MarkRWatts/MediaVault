// Serves cached poster/backdrop/still images, e.g. /api/poster/w342/abc123.jpg.
//
// Household-member gated like every other library read. (It used to be
// public because next/image's optimizer fetched it server-side without
// cookies; the app now renders plain <img> tags, so the session cookie
// arrives here and there is nothing left that has to be anonymous.)
//
//   - The path must be exactly <size>/<file> with `size` from TMDB's fixed
//     list and `file` a bare TMDB-style filename — nothing else is looked
//     up on disk, let alone fetched.
//   - A cache HIT is served to any member.
//   - A cache MISS is filled from TMDB only for the app owner (the /scan
//     page's candidate thumbnails, for films not yet in the library) or for
//     a file some database row actually references — never for an
//     arbitrary path a member types in. The fetch has a timeout, a byte cap
//     and an image content-type check.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireMemberOrResponse, requireOwnerOrResponse } from "@/lib/require-member";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// TMDB's published image sizes (https://developer.themoviedb.org/docs/image-basics).
const TMDB_SIZES = new Set([
  "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "h632", "original",
]);
// TMDB file paths are "/<27 alnum chars>.<jpg|png>"; be a little looser on
// length, strict on the alphabet: no dots beyond the extension, no
// separators, so path.resolve can't be steered anywhere.
const TMDB_FILE_RE = /^[A-Za-z0-9]{1,64}\.(jpe?g|png)$/;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function contentTypeFor(file: string): string {
  return file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

/** Is "/<file>" the poster/backdrop/still of anything we know about? Only
 *  consulted on a cache miss without a session, so the cost is bounded to
 *  the first fetch of each real image at each size. */
async function isReferencedImage(file: string): Promise<boolean> {
  const p = `/${file}`;
  const [film, collection, show, season, episode] = await Promise.all([
    prisma.film.findFirst({ where: { OR: [{ posterPath: p }, { backdropPath: p }] }, select: { id: true } }),
    prisma.collection.findFirst({ where: { OR: [{ posterPath: p }, { backdropPath: p }] }, select: { id: true } }),
    prisma.show.findFirst({ where: { OR: [{ posterPath: p }, { backdropPath: p }] }, select: { id: true } }),
    prisma.showSeason.findFirst({ where: { posterPath: p }, select: { id: true } }),
    prisma.episode.findFirst({ where: { stillPath: p }, select: { id: true } }),
  ]);
  return Boolean(film || collection || show || season || episode);
}

async function isAppOwner(): Promise<boolean> {
  return !((await requireOwnerOrResponse()) instanceof NextResponse);
}

async function fetchFromTmdb(size: string, file: string): Promise<Buffer | null> {
  const res = await fetch(`${TMDB_IMAGE_BASE}/${size}/${file}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
  return buf;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { path: segments } = await ctx.params;
  if (!segments || segments.length !== 2) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [size, file] = segments;
  if (!TMDB_SIZES.has(size) || !TMDB_FILE_RE.test(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cacheRoot = path.resolve(POSTER_CACHE_DIR);
  const dest = path.resolve(cacheRoot, size, file);
  // Belt and braces — the allow-lists above already make this unreachable.
  if (!dest.startsWith(cacheRoot + path.sep)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(dest);
  } catch {
    buf = null;
  }

  if (!buf) {
    if (!process.env.TMDB_API_KEY) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const allowed = (await isAppOwner()) || (await isReferencedImage(file));
    if (!allowed) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    try {
      buf = await fetchFromTmdb(size, file);
      if (!buf) return NextResponse.json({ error: "not found" }, { status: 404 });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
    } catch (err) {
      console.error("[api/poster] fetch/cache failed:", err);
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentTypeFor(file),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
