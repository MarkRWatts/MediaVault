// Cover art fetch for music albums: Cover Art Archive's release-group front
// image first, falling back to the iTunes Search API when CAA has nothing
// (common for small/classical releases with no CAA upload, or albums that
// never matched a MusicBrainz release-group at all). Caches the JPEG bytes
// under POSTER_CACHE_DIR/covers/<albumId>.jpg, mirroring tmdb.ts's
// cachePoster: best-effort throughout, never throws — a failed fetch just
// leaves Album.coverPath null.

import { promises as fs } from "node:fs";
import path from "node:path";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.join(POSTER_CACHE_DIR, "covers");
const CAA_BASE = "https://coverartarchive.org";
const ITUNES_SEARCH_BASE = "https://itunes.apple.com/search";
const USER_AGENT = "filmDB/1.3 (https://github.com/MarkRWatts/filmDB)";
// Sanity floor for both sources — a real cover is comfortably above this;
// CAA occasionally serves a tiny placeholder/error image on a technicality
// 200, and a truncated/failed download would also land under this.
const MIN_COVER_BYTES = 5 * 1024;

export interface CoverTarget {
  id: number;
  mbid: string | null;
  title: string;
  artistName: string;
}

async function fetchCaaCover(mbid: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${CAA_BASE}/release-group/${mbid}/front-250`, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_COVER_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// Cheap token-overlap similarity in [0, 1] — no need for a real string-
// distance dependency just to pick the best iTunes collection match.
function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const tokens = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
  const at = tokens(a);
  const bt = tokens(b);
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

async function fetchItunesCover(artistName: string, title: string): Promise<Buffer | null> {
  try {
    const url = new URL(ITUNES_SEARCH_BASE);
    url.searchParams.set("term", `${artistName} ${title}`);
    url.searchParams.set("entity", "album");
    url.searchParams.set("limit", "10");

    const res = await fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = (data.results ?? []) as any[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let best: any = null;
    let bestScore = 0;
    for (const r of results) {
      const score = titleSimilarity(r.collectionName ?? "", title);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best || bestScore <= 0.5 || !best.artworkUrl100) return null;

    const artUrl = (best.artworkUrl100 as string).replace("100x100bb", "300x300bb");
    const imgRes = await fetch(artUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.byteLength < MIN_COVER_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Fetch + cache a cover for one album: CAA release-group front image first
 * (only attempted when the album has an mbid), then the iTunes Search API as
 * a fallback (best `collectionName` similarity to the album title, > 0.5).
 * Returns the value to store on Album.coverPath ("<albumId>.jpg", relative
 * to POSTER_CACHE_DIR/covers/) or null if neither source produced a usable
 * image. Never throws — callers should treat a null return as "leave
 * coverPath unset and move on".
 */
export async function fetchCover(album: CoverTarget): Promise<string | null> {
  let buf: Buffer | null = null;
  if (album.mbid) buf = await fetchCaaCover(album.mbid);
  if (!buf) buf = await fetchItunesCover(album.artistName, album.title);
  if (!buf) return null;

  const fileName = `${album.id}.jpg`;
  try {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, fileName), buf);
    return fileName;
  } catch {
    return null;
  }
}
