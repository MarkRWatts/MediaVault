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

async function discogsFetch(pathname: string): Promise<unknown> {
  const url = new URL(`${DISCOGS_API_BASE}${pathname}`);
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

export interface DiscogsRelease {
  title: string;
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
    tracklist?: DiscogsTracklistEntry[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    images?: any[];
  };

  const images = data.images ?? [];
  const cover = images.find((img) => img.type === "primary") ?? images[0];

  return {
    title: data.title ?? "Untitled",
    tracks: parseDiscogsTracklist(data.tracklist),
    coverUrl: cover?.uri ?? null,
  };
}
