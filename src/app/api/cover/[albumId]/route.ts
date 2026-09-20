// Serves cached album cover art, e.g. /api/cover/42, optionally resized:
// /api/cover/42?size=256 fits the cover inside a 256px box (see
// cover-size.ts for why the sizes are an allowlist, and why a smaller
// cover is never enlarged to meet one). A resized copy is made once, with
// ffmpeg, and kept next to the original; a request for a size this box
// can't produce falls back to the stored cover rather than failing, so a
// client asking for one never has to handle a missing image.
//
// Unlike /api/poster
// (which receives the cache-relative path directly, since that IS the TMDB
// path), this route only receives the numeric Album id, so it looks up
// Album.coverPath first — covers are fetched/cached during enrichment
// (src/lib/discogs.ts + src/lib/cover-art.ts), not on demand here.
// Rejects any resolved path that would land outside the covers cache dir.
// Household-member gated like every other library read: images are plain
// <img> tags now (no next/image optimizer, which fetched server-side
// without cookies), so the browser's session cookie arrives here.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { type CoverSize, parseCoverSize, resizeArgs, resizedCoverPath } from "@/lib/cover-size";
import { prisma } from "@/lib/db";
import { ffmpegPath } from "@/lib/ffmpeg-bin";
import { requireMemberOrResponse } from "@/lib/require-member";

const execFileAsync = promisify(execFile);

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.resolve(POSTER_CACHE_DIR, "covers");

export async function GET(_req: NextRequest, ctx: { params: Promise<{ albumId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { albumId: albumIdParam } = await ctx.params;
  const albumId = Number(albumIdParam);
  if (!Number.isInteger(albumId)) {
    return NextResponse.json({ error: "invalid album id" }, { status: 400 });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { coverPath: true } });
  if (!album?.coverPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const source = path.resolve(COVERS_DIR, album.coverPath);
  if (source !== COVERS_DIR && !source.startsWith(COVERS_DIR + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let sourceStat: { mtimeMs: number };
  try {
    sourceStat = await fs.stat(source);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Anything other than a size this box can make lands on the stored
  // cover: too big is a waste, but it is still the right picture.
  const size = parseCoverSize(_req.nextUrl.searchParams.get("size"));
  const dest = size ? await resizedOrOriginal(album.coverPath, size, source, sourceStat.mtimeMs) : source;

  let buf: Buffer;
  let stat: { mtimeMs: number; size: number };
  try {
    [buf, stat] = await Promise.all([fs.readFile(dest), fs.stat(dest)]);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Unlike /api/poster, a cover's bytes CAN change under the same URL (a
  // re-enrichment swaps the cached file in place — e.g. embedded art
  // replacing an online fetch), so `immutable` here left browsers showing
  // stale art for up to a year. Serve with an mtime+size ETag and always
  // revalidate: LAN 304s are cheap, cover swaps show up on the next load.
  //
  // The requested size is part of the tag: two sizes sharing one would
  // let a 304 hand a client the bytes of the other.
  const etag = `"${size ?? 0}-${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (_req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: etag,
    },
  });
}

/// The resized copy, made if it isn't there yet (or is older than the
/// cover it came from). Returns the original's path if this box has no
/// working ffmpeg, or if the resize fails for any other reason — an
/// oversized cover beats a broken image.
async function resizedOrOriginal(
  coverPath: string,
  size: CoverSize,
  source: string,
  sourceMtimeMs: number,
): Promise<string> {
  const dest = path.resolve(COVERS_DIR, resizedCoverPath(coverPath, size));
  if (!dest.startsWith(COVERS_DIR + path.sep)) return source;

  try {
    const existing = await fs.stat(dest);
    if (existing.mtimeMs >= sourceMtimeMs) return dest;
  } catch {
    // Not made yet — fall through and make it.
  }

  // Into a uniquely-named temporary first, then renamed: two requests for
  // the same new size arrive together often (a grid drawing twelve tiles),
  // and a half-written JPEG must never be servable.
  const tmp = `${dest}.${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await execFileAsync(ffmpegPath(), resizeArgs(source, size, tmp), {
      maxBuffer: 1024 * 1024 * 32,
    });
    await fs.rename(tmp, dest);
    return dest;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    // Falling back is right — an oversized cover beats a broken image —
    // but doing it silently is how a resize that never once succeeded
    // went unnoticed while every client downloaded full-size files.
    console.error(`[api/cover] resize to ${size} failed for ${coverPath}:`, err);
    return source;
  }
}
