// Best-effort UPC/EAN -> product title lookup for movie barcodes. There's no
// free, authoritative barcode database for DVD/Blu-ray the way Discogs
// covers CD/vinyl (see searchDiscogsByBarcode in discogs.ts), so this
// hits UPCitemdb's free trial endpoint and returns a title guess for the
// caller to fuzzy-match against TMDB. Never throws — a failed/rate-limited
// lookup just means "couldn't identify this barcode", not a hard error.
//
// UPCitemdb's trial tier throttles bursts, and says so two ways: a 200
// whose body is {code:"TOO_FAST"}, or (measured 2026-09-25, from the
// production VM) an HTTP 429 with the same body — three calls inside about
// two seconds trip it, and the block lasts somewhere between 10 and 20
// seconds. The 429 form used to fall through as "not found", so a batch
// scan, or the Scan app re-reading one disc, got a confident "not
// recognised" for a barcode the service knows perfectly well.
//
// So: calls are spaced (MIN_INTERVAL_MS, measured safe), answers are
// cached (a re-scan never costs a call), a block is waited out once, and a
// block that outlasts that is thrown as UpcBusyError — "try again in a
// moment", never "unknown".

const UPCITEMDB_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const MIN_INTERVAL_MS = 1500;
/** How long a TOO_FAST block is assumed to last before one retry. */
const BLOCK_MS = 12_000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

/** UPCitemdb is refusing calls for now; the barcode may well be known. */
export class UpcBusyError extends Error {
  constructor() {
    super("The film barcode service is busy. Try again in a few seconds.");
    this.name = "UpcBusyError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Module state is per server process, which is the unit UPCitemdb limits
// (by IP) anyway.
let lastCallAt = 0;
let blockedUntil = 0;
const cache = new Map<string, { result: UpcLookupResult | null; expiresAt: number }>();

async function throttle(): Promise<void> {
  const now = Date.now();
  const next = Math.max(lastCallAt + MIN_INTERVAL_MS, blockedUntil);
  lastCallAt = Math.max(now, next);
  if (next > now) await sleep(next - now);
}

function remember(barcode: string, result: UpcLookupResult | null) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(barcode, { result, expiresAt: Date.now() + (result ? HIT_TTL_MS : MISS_TTL_MS) });
}

/** Test hook: forget the cache and any throttle/block state. */
export function resetUpcLookupState() {
  lastCallAt = 0;
  blockedUntil = 0;
  cache.clear();
}

export interface UpcLookupResult {
  title: string;
  year: number | null;
}

/**
 * "title" is retailer-listing copy, not a clean product name — observed
 * shapes include the barcode itself echoed back ("Ant Man & The Wasp,
 * 8717418538514"), actor names and region/format tags trailing after a
 * comma ("Kingsman: The Secret Service [blu-ray], 5039036072847, Colin
 * Firth, Samuel L. J."), and bare unpunctuated keyword-stuffing with no
 * separator at all ("Thor Ragnarok Blu-ray 2017 Marvel Film Movie Comic Pre
 * Order For 26th February"). `barcode`, when given, strips that literal
 * echo — an exact string match, so it can't misfire the way a generic
 * digit-run regex could (e.g. eating a real release year).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseUpcItemDbResponse(data: any, barcode?: string): UpcLookupResult | null {
  const item = data?.items?.[0];
  if (!item?.title) return null;

  let title: string = item.title;
  let year: number | null = null;

  if (barcode) {
    title = title.split(barcode).join(" ");
  }

  const yearMatch = title.match(/\[(\d{4})\]|\((\d{4})\)/);
  if (yearMatch) {
    year = Number(yearMatch[1] ?? yearMatch[2]);
    title = title.slice(0, yearMatch.index).trim();
  }

  // Any parenthetical/bracketed aside past this point is packaging noise
  // ("(UK Import)", "[Region B]", "[Blu-ray]") — the one case worth keeping,
  // a bare release year, was already pulled out above.
  title = title.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "");

  // A comma in this data is reliably followed by junk (an echoed barcode,
  // cast names, region notes) — take the segment before it.
  const commaIdx = title.indexOf(",");
  if (commaIdx !== -1) title = title.slice(0, commaIdx);

  // A bare (unpunctuated) format/edition keyword marks the same kind of
  // boundary when there's no comma to split on.
  const formatMatch = title.match(/\b(?:blu-?ray|dvd|4k uhd|uhd|region free|region [abc])\b/i);
  if (formatMatch && formatMatch.index !== undefined) {
    title = title.slice(0, formatMatch.index);
  }

  title = title.replace(/[-:,]+$/, "").trim();

  if (!title) return null;
  return { title, year };
}

/**
 * The retailer title UPCitemdb has for `barcode`, or null when it has
 * none (or answered with an error that retrying won't fix). Throws
 * UpcBusyError when UPCitemdb is still throttling after one wait.
 */
export async function lookupMovieByBarcode(barcode: string): Promise<UpcLookupResult | null> {
  const cached = cache.get(barcode);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    let res: Response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      res = await fetch(`${UPCITEMDB_URL}?upc=${encodeURIComponent(barcode)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      data = await res.json().catch(() => null);
    } catch {
      return null;
    }
    if (res.status === 429 || data?.code === "TOO_FAST") {
      blockedUntil = Date.now() + BLOCK_MS;
      continue;
    }
    if (!res.ok) return null;
    const result = parseUpcItemDbResponse(data, barcode);
    remember(barcode, result);
    return result;
  }
  throw new UpcBusyError();
}
