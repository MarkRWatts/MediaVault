// Minimal HTTP Range header parsing (RFC 7233) for byte-range video serving.
// Only the single-range form browsers actually send for <video> seeking
// (`bytes=N-` / `bytes=N-M` / `bytes=-N`) is supported — multi-range requests
// aren't something any real player issues here.

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/** Returns null when there's no Range header (caller should send a plain 200),
 * or "unsatisfiable" when the header is present but out of bounds for
 * `size` (caller should send 416 with Content-Range: bytes *\/size). */
export function parseRange(rangeHeader: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "unsatisfiable";

  let start: number;
  let end: number;

  if (match[1] === "") {
    // Suffix range: last N bytes.
    const suffixLength = Number(match[2]);
    if (suffixLength <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) {
    return "unsatisfiable";
  }

  return { start, end: Math.min(end, size - 1) };
}
