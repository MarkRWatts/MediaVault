// One guarded download for every image this app caches from a third party
// (TMDB posters, ThePornDB artwork, iTunes/Discogs covers, Wikipedia/Fanart
// artist images). The individual fetch sites used to buffer whatever came
// back — no size ceiling, sometimes no timeout, never a content-type check
// — so a misbehaving or compromised upstream could hand the process a
// multi-gigabyte body or non-image bytes that were then written to disk as
// `.jpg`. Every site now goes through this.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface FetchImageOptions {
  timeoutMs?: number;
  /** Bodies larger than this (declared or actual) are discarded. */
  maxBytes?: number;
  /** Bodies smaller than this are treated as a miss (placeholder GIFs etc). */
  minBytes?: number;
  headers?: Record<string, string>;
}

/** Download an image, or null for any non-OK, non-image, oversized,
 *  undersized or timed-out response. Never throws. */
export async function fetchImage(url: string, opts: FetchImageOptions = {}): Promise<Buffer | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    // Some image CDNs answer with octet-stream; anything else (HTML error
    // pages, JSON) is not an image and must not be cached as one.
    if (!type.startsWith("image/") && !type.startsWith("application/octet-stream")) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    if (buf.byteLength < (opts.minBytes ?? 1)) return null;
    return buf;
  } catch {
    return null;
  }
}

/** A single path segment safe to join under a cache directory: letters,
 *  digits, dot, dash, underscore — no separators, never "." or "..". Used
 *  where the segment comes from an upstream API rather than our own code. */
export function safeCacheSegment(raw: string | number): string | null {
  const s = String(raw);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s) || s === "." || s === "..") return null;
  return s;
}
