// Best-effort UPC/EAN -> product title lookup for movie barcodes. There's no
// free, authoritative barcode database for DVD/Blu-ray the way MusicBrainz
// covers CD/vinyl (see searchReleaseByBarcode in musicbrainz.ts), so this
// hits UPCitemdb's free trial endpoint and returns a title guess for the
// caller to fuzzy-match against TMDB. Never throws — a failed/rate-limited
// lookup just means "couldn't identify this barcode", not a hard error.
//
// UPCitemdb's trial tier throttles aggressively (observed: back-to-back
// calls a couple of seconds apart return {code:"TOO_FAST"} instead of data)
// — a batch scanning session that processes several barcodes in a row was
// silently losing most of them to this, indistinguishable from a genuine
// "not found". throttle()/RETRY_BACKOFF_MS mirror the same pattern
// musicbrainz.ts already uses for MusicBrainz's real 1 req/s cap.

const UPCITEMDB_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const MIN_INTERVAL_MS = 1200;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
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

export async function lookupMovieByBarcode(barcode: string): Promise<UpcLookupResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    try {
      const res = await fetch(`${UPCITEMDB_URL}?upc=${encodeURIComponent(barcode)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.code === "TOO_FAST" && attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return parseUpcItemDbResponse(data, barcode);
    } catch {
      return null;
    }
  }
  return null;
}
