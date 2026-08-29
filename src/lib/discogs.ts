// Discogs fallback for pressing-specific tracklist/cover art — used only
// when MusicBrainz has no entry at all for a given pressing (common for
// smaller-run or newer vinyl; MusicBrainz coverage skews toward CD/digital).
// See attachPhysicalRelease in musicbrainz.ts, which dispatches to either
// source based on the URL/id the owner pastes.
//
// Unlike MusicBrainz, Discogs needs no API key for read-only release lookups
// at this app's volume (one-off manual links, not bulk enrichment) — just a
// User-Agent, same courtesy as musicbrainz.ts. An optional DISCOGS_TOKEN
// raises the rate limit (25/min unauthenticated -> 60/min) if it's ever
// needed.

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";

export const DISCOGS_URL_RE = /discogs\.com\/release\/(\d+)/i;

// A master groups every pressing of a release across editions/reissues —
// it has no tracklist/cover of its own that corresponds to a specific
// physical item, only a `main_release` pointer to the release Discogs
// considers canonical. Resolving one just means resolving that release
// instead (see resolveDiscogsUrl in scan-resolve.ts).
export const DISCOGS_MASTER_URL_RE = /discogs\.com\/master\/(\d+)/i;

async function discogsFetch(pathname: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${DISCOGS_API_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const token = process.env.DISCOGS_TOKEN;
  if (token) url.searchParams.set("token", token);

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Discogs ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

/** Parse Discogs' "M:SS" (or "H:MM:SS") duration string. Empty/unparseable -> null. */
export function parseDiscogsDuration(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const parts = duration.split(":").map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export interface ParsedDiscogsTrack {
  disc: number;
  trackNumber: number | null;
  title: string;
  durationSecs: number | null;
}

/** Parse a Discogs position string ("A1", "B12", "1-3", "7") into {disc, trackNumber}. */
function parsePosition(position: string): { disc: number; trackNumber: number | null } {
  let m = /^([A-Za-z])(\d+)$/.exec(position);
  if (m) return { disc: m[1].toUpperCase().charCodeAt(0) - "A".charCodeAt(0) + 1, trackNumber: Number(m[2]) };

  m = /^(\d+)-(\d+)$/.exec(position);
  if (m) return { disc: Number(m[1]), trackNumber: Number(m[2]) };

  m = /^(\d+)$/.exec(position);
  if (m) return { disc: 1, trackNumber: Number(m[1]) };

  return { disc: 1, trackNumber: null };
}

interface DiscogsTracklistEntry {
  position?: string;
  type_?: string;
  title?: string;
  duration?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sub_tracks?: any[];
}

/**
 * Flatten a Discogs release's tracklist into a disc-ordered list. Classical
 * multi-movement works are grouped under a type_:"index" heading with no
 * position/duration of its own and the real tracks nested in sub_tracks
 * (e.g. Anna Lapwood's "Firedove" CD) — the heading itself is skipped, its
 * sub_tracks are flattened in. A position that can't be parsed at all (rare)
 * falls back to sequential numbering within the flattened list, same spirit
 * as parseReleaseMedia's MusicBrainz fallback.
 */
export function parseDiscogsTracklist(
  tracklist: DiscogsTracklistEntry[] | null | undefined,
): ParsedDiscogsTrack[] {
  const flat: DiscogsTracklistEntry[] = [];
  for (const entry of tracklist ?? []) {
    if (entry.type_ === "index" && Array.isArray(entry.sub_tracks)) {
      flat.push(...entry.sub_tracks);
    } else if (entry.position) {
      flat.push(entry);
    }
  }

  return flat.map((t, i) => {
    const { disc, trackNumber } = parsePosition(t.position ?? "");
    return {
      disc,
      trackNumber: trackNumber ?? i + 1,
      title: t.title || "Untitled",
      durationSecs: parseDiscogsDuration(t.duration),
    };
  });
}

function formatDiscogsFormats(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formats: any[] | null | undefined,
): string | null {
  if (!formats || formats.length === 0) return null;
  return formats.map((f) => [f.name, ...(f.descriptions ?? [])].filter(Boolean).join(" ")).join(", ");
}

export interface DiscogsRelease {
  title: string;
  artistName: string;
  year: number | null;
  /** Human-readable format, e.g. "Vinyl LP Album" — built from Discogs'
   *  formats[].name + descriptions[]. Used only for display/medium-guessing,
   *  same spirit as MusicBrainz's media[0].format elsewhere in this app. */
  format: string | null;
  tracks: ParsedDiscogsTrack[];
  /** Full-size front cover URL, if Discogs has one — prefers the
   *  owner-submitted "primary" image, falling back to the first image of
   *  any type (may be something like a shrinkwrapped-sleeve photo rather
   *  than proper cover art — Discogs images are user-submitted and vary in
   *  quality; there's no reliable way to tell from the API alone). */
  coverUrl: string | null;
}

export async function fetchDiscogsRelease(releaseId: number): Promise<DiscogsRelease> {
  const data = (await discogsFetch(`/releases/${releaseId}`)) as {
    title?: string;
    year?: number;
    tracklist?: DiscogsTracklistEntry[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    artists?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formats?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    images?: any[];
  };

  const images = data.images ?? [];
  const cover = images.find((img) => img.type === "primary") ?? images[0];

  return {
    title: data.title ?? "Untitled",
    artistName: data.artists?.[0]?.name || "Unknown Artist",
    year: data.year || null,
    format: formatDiscogsFormats(data.formats),
    tracks: parseDiscogsTracklist(data.tracklist),
    coverUrl: cover?.uri ?? null,
  };
}

/** Resolve a Discogs master id to the release id Discogs considers
 *  canonical for it (`main_release`) — a master itself has no single
 *  tracklist/cover/format tied to one physical item, only this pointer. */
export async function fetchDiscogsMasterMainRelease(masterId: number): Promise<number> {
  const data = (await discogsFetch(`/masters/${masterId}`)) as { main_release?: number };
  if (!data.main_release) throw new Error(`Discogs master ${masterId} has no main_release`);
  return data.main_release;
}

export interface DiscogsBarcodeMatch {
  discogsReleaseId: number;
  title: string;
  artistName: string;
  year: number | null;
  format: string | null;
  coverUrl: string | null;
}

/**
 * Resolve a barcode via Discogs' own database search — the fallback for
 * when MusicBrainz's barcode index has nothing (see searchReleaseByBarcode
 * in musicbrainz.ts), which happens often enough for smaller-run/newer
 * vinyl that Mark specifically asked for this. A barcode can legitimately be
 * shared by several colour-vinyl/regional variants of the same release
 * (label barcode reuse, not a data error) — there's no reliable way to pick
 * the "right" one from the barcode alone, so this takes the first result
 * whose own barcode list actually contains an exact match. Track content is
 * identical across such variants either way; only the cover art might not
 * exactly match the specific one owned.
 *
 * IMPORTANT: Discogs' `barcode=` search parameter is NOT an exact-match
 * filter — an unassigned/garbage barcode (verified against "0000000000000")
 * still returns millions of loosely-relevant "hits" (it silently falls back
 * to full-text search across matrix/runout numbers, label codes, etc. once
 * nothing matches as a barcode). Blindly trusting the top result would
 * misidentify almost every non-matching scan, so every candidate's own
 * barcode array is checked here for an exact digit-normalized match before
 * it's accepted — never trust an un-verified hit.
 */
export async function searchDiscogsByBarcode(barcode: string): Promise<DiscogsBarcodeMatch | null> {
  const data = (await discogsFetch("/database/search", { barcode, type: "release" })) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results?: any[];
  };

  const verified = (data.results ?? []).find((r) =>
    (r.barcode ?? []).some((b: string) => b.replace(/\D/g, "") === barcode),
  );
  if (!verified) return null;

  // The search endpoint's own fields are unreliable for a clean artist name
  // (title is a combined "Artist - Title" string) and cover art (thumb/
  // cover_image are often blank, as seen on this exact release) — the full
  // release fetch has both properly.
  const release = await fetchDiscogsRelease(verified.id);
  return {
    discogsReleaseId: verified.id,
    title: release.title,
    artistName: release.artistName,
    year: release.year,
    format: release.format,
    coverUrl: release.coverUrl,
  };
}
