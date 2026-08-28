// Best-effort UPC/EAN -> product title lookup for movie barcodes. There's no
// free, authoritative barcode database for DVD/Blu-ray the way MusicBrainz
// covers CD/vinyl (see searchReleaseByBarcode in musicbrainz.ts), so this
// hits UPCitemdb's free trial endpoint and returns a title guess for the
// caller to fuzzy-match against TMDB. Never throws — a failed/rate-limited
// lookup just means "couldn't identify this barcode", not a hard error.

const UPCITEMDB_URL = "https://api.upcitemdb.com/prod/trial/lookup";

export interface UpcLookupResult {
  title: string;
  year: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseUpcItemDbResponse(data: any): UpcLookupResult | null {
  const item = data?.items?.[0];
  if (!item?.title) return null;

  // "title" is often noisy retailer copy, e.g. "The Matrix (Blu-ray) [1999]
  // Warner Bros" — strip a leading (Format) tag and a trailing [year] before
  // handing it to the TMDB title search.
  let title: string = item.title;
  let year: number | null = null;

  const yearMatch = title.match(/\[(\d{4})\]|\((\d{4})\)/);
  if (yearMatch) {
    year = Number(yearMatch[1] ?? yearMatch[2]);
    title = title.slice(0, yearMatch.index).trim();
  }

  title = title
    .replace(/\((?:blu-?ray|dvd|4k|uhd|widescreen|full screen)[^)]*\)/gi, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();

  if (!title) return null;
  return { title, year };
}

export async function lookupMovieByBarcode(barcode: string): Promise<UpcLookupResult | null> {
  try {
    const res = await fetch(`${UPCITEMDB_URL}?upc=${encodeURIComponent(barcode)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseUpcItemDbResponse(await res.json());
  } catch {
    return null;
  }
}
