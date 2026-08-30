// Cover art fetch for music albums. Priority for an OWNED album: (1) the
// art embedded in the album's own files — the owner hand-curated these via
// iTunes, so for anything on disk this beats any online source; (2) the
// iTunes Search API. An owned=false album (no files on disk) only has (2)
// available at the album level — Discogs cover art is fetched opportunistically
// via a linked PhysicalCopy (see fetchDiscogsPhysicalCopyCover/
// fetchDiscogsAlbumCover below), not as a standalone album-level tier, since
// it has no equivalent of Cover Art Archive's release-group-keyed lookup.
// Caches bytes under POSTER_CACHE_DIR/covers/<albumId>.jpg, mirroring
// tmdb.ts's cachePoster: best-effort throughout, never throws — a failed
// fetch just leaves Album.coverPath (and coverSource) unset. A coverSource
// of "manual" (owner-curated cache override) is the caller's responsibility
// to never overwrite — fetchCover refuses outright if asked to.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";

const execFileAsync = promisify(execFile);

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const COVERS_DIR = path.join(POSTER_CACHE_DIR, "covers");
const ITUNES_SEARCH_BASE = "https://itunes.apple.com/search";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";
// Sanity floor for the online sources — a real cover is comfortably above
// this; a source occasionally serving a tiny placeholder/error image on a
// technicality 200, or a truncated/failed download, would land under this.
const MIN_COVER_BYTES = 5 * 1024;
// Embedded art comes straight off disk (no truncation risk), so a much
// lower floor is enough to catch a genuinely empty/corrupt attached-picture
// stream without rejecting a small-but-real cover.
const MIN_EMBEDDED_COVER_BYTES = 2 * 1024;
// iTunes title-similarity floor — raised from 0.5 after a real match
// ("Hits! The Very Best of Erasure" -> a Curtis Mayfield album) showed
// title-overlap alone isn't a strong enough filter; paired with the new
// mandatory artist-name check below.
const ITUNES_TITLE_THRESHOLD = 0.6;

export type CoverSource = "embedded" | "itunes" | "discogs" | "manual";

export interface CoverTarget {
  id: number;
  title: string;
  artistName: string;
  /** Whether the album has files on disk — gates the embedded-art attempt. */
  owned: boolean;
  /** Current Album.coverSource — "manual" means fetchCover must no-op. */
  coverSource: string | null;
}

export interface CoverResult {
  /** Value to store on Album.coverPath ("<albumId>.jpg", relative to POSTER_CACHE_DIR/covers/). */
  fileName: string;
  source: CoverSource;
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

// Lowercase + diacritics-stripped, collapsed to a single space-joined token
// run — deliberately looser than titleSimilarity's tokenizer (no set/overlap
// math) since this is a whole-string containment check, not a similarity
// score.
function normalizeArtistCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Reject an iTunes hit whose credited artist has nothing to do with the
 * album's actual artist — the check that would have caught "Hits! The Very
 * Best of Erasure" matching a Curtis Mayfield collection on title overlap
 * alone. Normalized (lowercase, diacritics-stripped) names must be equal, or
 * one must contain the other (handles "Erasure" vs "Erasure feat. X" style
 * credit variance) — anything less is rejected.
 */
export function verifyArtistMatch(hitArtistName: string, albumArtistName: string): boolean {
  const a = normalizeArtistCompare(hitArtistName);
  const b = normalizeArtistCompare(albumArtistName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export interface ItunesHit {
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
}

/**
 * Pick the best iTunes Search result for an album: among hits whose artist
 * survives verifyArtistMatch, the highest title-similarity one above
 * ITUNES_TITLE_THRESHOLD. Pure/no network — exported for unit tests.
 */
export function pickItunesHit(hits: ItunesHit[], artistName: string, title: string): ItunesHit | null {
  let best: ItunesHit | null = null;
  let bestScore = 0;
  for (const hit of hits) {
    if (!verifyArtistMatch(hit.artistName ?? "", artistName)) continue;
    const score = titleSimilarity(hit.collectionName ?? "", title);
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  if (!best || bestScore <= ITUNES_TITLE_THRESHOLD || !best.artworkUrl100) return null;
  return best;
}

async function fetchItunesCover(artistName: string, title: string): Promise<Buffer | null> {
  try {
    const url = new URL(ITUNES_SEARCH_BASE);
    url.searchParams.set("term", `${artistName} ${title}`);
    url.searchParams.set("entity", "album");
    url.searchParams.set("limit", "10");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.results ?? []) as ItunesHit[];

    const best = pickItunesHit(results, artistName, title);
    if (!best?.artworkUrl100) return null;

    const artUrl = best.artworkUrl100.replace("100x100bb", "300x300bb");
    const imgRes = await fetch(artUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.byteLength < MIN_COVER_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// --- Embedded art (ffmpeg) ---
//
// Every owned m4a on the share carries an attached-picture video stream
// (mjpeg, occasionally png) that the owner hand-curated via iTunes. We pull
// it out with `ffmpeg -map 0:v:0 -frames:v 1 -c copy` — a stream *copy* of a
// single frame into an image2-muxed file, i.e. a lossless remux of the
// embedded bitstream, not a re-encode. `-c copy` writes the raw stream bytes
// regardless of the output filename's extension (the image2 muxer only
// picks an encoder when actually encoding), so we always target "cover.jpg"
// and let it hold whatever bytes come out (mjpeg or, rarely, png) — browsers
// sniff content by magic bytes, not extension, so this renders fine either
// way. A track with no attached-picture stream (or a .m4p DRM file we never
// probe) simply makes the `-map 0:v:0` fail; that failure is caught and
// treated as "no embedded art", falling through to iTunes.
//
// Mirrors ffprobe.ts's local-vs-docker fallback: prefer `ffmpeg` on PATH,
// else run the same FFPROBE_DOCKER_IMAGE (mwader/static-ffmpeg ships both
// /ffprobe and /ffmpeg entrypoints) with the music root mounted read-only
// for input and a scratch temp dir mounted read-write for output.

let hasLocalFfmpegPromise: Promise<boolean> | null = null;
function detectLocalFfmpeg(): Promise<boolean> {
  if (!hasLocalFfmpegPromise) {
    hasLocalFfmpegPromise = execFileAsync("ffmpeg", ["-version"])
      .then(() => true)
      .catch(() => false);
  }
  return hasLocalFfmpegPromise;
}

const FFMPEG_ARGS = ["-y", "-map", "0:v:0", "-frames:v", "1", "-c", "copy"];

async function extractEmbeddedCover(absTrackPath: string, musicPath: string): Promise<Buffer | null> {
  let tmpDir: string;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediavault-cover-"));
  } catch {
    return null;
  }
  const tmpOut = path.join(tmpDir, "cover.jpg");

  try {
    const hasLocal = await detectLocalFfmpeg();
    if (hasLocal) {
      await execFileAsync("ffmpeg", ["-i", absTrackPath, ...FFMPEG_ARGS, tmpOut], {
        maxBuffer: 1024 * 1024 * 32,
      });
    } else {
      const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
      if (!dockerImage) return null;

      const rel = path.relative(musicPath, absTrackPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      const containerIn = `/probe-root/${rel.split(path.sep).join("/")}`;

      const dockerArgs = [
        "run",
        "--rm",
        "--entrypoint",
        "/ffmpeg",
        "-v",
        `${musicPath}:/probe-root:ro`,
        "-v",
        `${tmpDir}:/out`,
        dockerImage,
        "-i",
        containerIn,
        ...FFMPEG_ARGS,
        "/out/cover.jpg",
      ];
      await execFileAsync("docker", dockerArgs, { maxBuffer: 1024 * 1024 * 32 });
    }

    const buf = await fs.readFile(tmpOut);
    if (buf.byteLength < MIN_EMBEDDED_COVER_BYTES) return null;
    return buf;
  } catch {
    // No video stream (`-map 0:v:0` failure), ffmpeg/docker unavailable, or
    // any other extraction hiccup — all treated as "no embedded art".
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fetch the album's first track (by disc, then track number), skipping .m4p
 * DRM files since they're never probed and can't be read anyway, and pull
 * its embedded cover art. Returns null (no attempt) when MUSIC_PATH isn't
 * set, the album has no usable track, or extraction found nothing.
 */
async function fetchEmbeddedCoverForAlbum(albumId: number): Promise<Buffer | null> {
  const musicPath = process.env.MUSIC_PATH;
  if (!musicPath) return null;

  const track = await prisma.track.findFirst({
    where: { albumId, codec: { not: "drm" } },
    orderBy: [{ disc: "asc" }, { trackNumber: "asc" }],
  });
  if (!track) return null;

  const absTrackPath = path.join(musicPath, track.filePath);
  return extractEmbeddedCover(absTrackPath, musicPath);
}

/**
 * Fetch + cache a cover for one album. Priority for an owned album:
 * embedded art (from its own files) -> iTunes Search. An owned=false album
 * (no files) skips straight to iTunes. Discogs cover art has no
 * album-level (group-keyed) lookup the way Cover Art Archive did — it's
 * only fetched opportunistically via a linked PhysicalCopy, see
 * fetchDiscogsPhysicalCopyCover/fetchDiscogsAlbumCover below. Refuses
 * outright (returns null) when the album's current coverSource is "manual"
 * — that's an owner-curated override and must never be replaced. Never
 * throws — callers should treat a null return as "leave coverPath/coverSource
 * unset and move on".
 */
export async function fetchCover(album: CoverTarget): Promise<CoverResult | null> {
  if (album.coverSource === "manual") return null;

  let buf: Buffer | null = null;
  let source: CoverSource | null = null;

  if (album.owned) {
    buf = await fetchEmbeddedCoverForAlbum(album.id);
    if (buf) source = "embedded";
  }
  if (!buf) {
    buf = await fetchItunesCover(album.artistName, album.title);
    if (buf) source = "itunes";
  }
  if (!buf || !source) return null;

  const fileName = `${album.id}.jpg`;
  try {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, fileName), buf);
    return { fileName, source };
  } catch {
    return null;
  }
}

/**
 * Cache cover art for one specific pressing (PhysicalCopy), keyed by its own
 * file name so it never collides with — or overwrites — the album's main
 * cover. A miss is a normal outcome, not an error — the album's own cover
 * still shows for this copy. Refuses outright when coverSource is already
 * "manual", same convention as fetchCover.
 */
async function cachePhysicalCopyCover(
  albumId: number,
  medium: string,
  buf: Buffer,
  source: CoverSource,
): Promise<CoverResult | null> {
  const fileName = `${albumId}-${medium.toLowerCase()}.jpg`;
  try {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, fileName), buf);
    return { fileName, source };
  } catch {
    return null;
  }
}

/**
 * Pressing-specific cover fetch (see discogs.ts) — Discogs hands back a
 * direct, full-size image URL already, so this is a plain download. May be
 * a lower-quality or off-target photo (e.g. shrinkwrapped sleeve) —
 * Discogs images are user-submitted and there's no way to verify quality
 * from the API alone.
 */
export async function fetchDiscogsPhysicalCopyCover(copy: {
  albumId: number;
  medium: string;
  coverUrl: string;
  coverSource: string | null;
}): Promise<CoverResult | null> {
  if (copy.coverSource === "manual") return null;

  try {
    const res = await fetch(copy.coverUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_COVER_BYTES) return null;
    return cachePhysicalCopyCover(copy.albumId, copy.medium, buf, "discogs");
  } catch {
    return null;
  }
}

/**
 * Album-level fallback for a physical-only album whose iTunes cover search
 * came up empty too (see fetchCover above) — common for small-run/novelty
 * releases (a kids' TV tie-in single, say). Reuses the same pressing photo
 * just fetched for its PhysicalCopy rather than leaving the album with no
 * cover at all when a usable image is already in hand. The caller (see
 * populatePhysicalReleaseFromDiscogs in discogs.ts) only calls this when
 * the album genuinely has none yet — never overwrites an existing or
 * manually-set one.
 */
export async function fetchDiscogsAlbumCover(albumId: number, coverUrl: string): Promise<CoverResult | null> {
  try {
    const res = await fetch(coverUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_COVER_BYTES) return null;
    const fileName = `${albumId}.jpg`;
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, fileName), buf);
    return { fileName, source: "discogs" };
  } catch {
    return null;
  }
}
