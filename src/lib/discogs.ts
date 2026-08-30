// Discogs: the sole metadata/matching source for music (see PLAN.md — this
// replaced MusicBrainz entirely). Handles artist matching, an artist's full
// discography (masters + standalone releases), barcode lookup, and
// pressing-specific tracklist/cover fetch — mirrors src/lib/tmdb.ts's shape
// (pickHit-style matching, EXACT/SEARCH/LOW confidence, placeholder reclaim,
// never-merge-except-exact, ScanRun progress/log).
//
// Unlike MusicBrainz, Discogs needs no API key for read-only lookups at this
// app's volume — just a User-Agent. An optional DISCOGS_TOKEN raises the
// rate limit (25/min unauthenticated -> 60/min); strongly recommended before
// running a full-catalogue Enrich Music pass (see runMusicEnrich below).

import { prisma } from "@/lib/db";
import { normalizeTitle, sortTitle } from "@/lib/parse";
import type { Artist } from "@/generated/prisma/client";
import type { AlbumKind } from "@/lib/constants";
import { MUSIC_GAP_MIN_OWNED, MUSIC_GAP_MIN_PCT } from "@/lib/constants";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";
import { fetchCover, fetchDiscogsPhysicalCopyCover, fetchDiscogsAlbumCover } from "@/lib/cover-art";
import { fetchArtistEnrichment } from "@/lib/artist-bio";

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";
const PROGRESS_UPDATE_EVERY = 3;
const RETRY_BACKOFF_MS = 3000;
// Discogs' unauthenticated rate limit is 25/min (60/min with DISCOGS_TOKEN
// set); throttled on a shared "earliest next call" clock (the same fixed-
// interval-scheduler pattern this app also uses for TMDB/ThePornDB) — a
// full-catalogue Enrich Music pass now depends on this heavily, so every
// call funnels through here rather than trusting
// individual call sites to space themselves out.
const MIN_INTERVAL_MS = process.env.DISCOGS_TOKEN ? 1000 : 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function discogsFetch(pathname: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${DISCOGS_API_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const token = process.env.DISCOGS_TOKEN;
  if (token) url.searchParams.set("token", token);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new Error(`Discogs ${pathname} -> ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return res.json();
    if (attempt === 0 && isTransientStatus(res.status)) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`Discogs ${pathname} -> HTTP ${res.status}`);
  }
}

export const DISCOGS_URL_RE = /discogs\.com\/release\/(\d+)/i;

// A master groups every pressing of a release across editions/reissues —
// it has no tracklist/cover of its own that corresponds to a specific
// physical item, only a `main_release` pointer to the release Discogs
// considers canonical. Resolving one just means resolving that release
// instead (see resolveDiscogsUrl in scan-resolve.ts).
export const DISCOGS_MASTER_URL_RE = /discogs\.com\/master\/(\d+)/i;

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
 * falls back to sequential numbering within the flattened list.
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
   *  formats[].name + descriptions[]. Used for display/medium-guessing and
   *  (via formatDiscogsFormats' raw descriptors) kind classification. */
  format: string | null;
  tracks: ParsedDiscogsTrack[];
  /** Full-size front cover URL, if Discogs has one — prefers the
   *  owner-submitted "primary" image, falling back to the first image of
   *  any type. */
  coverUrl: string | null;
  /** The master this release belongs to, if any — not every release has
   *  one (small-run/promo pressings commonly don't). Used to resolve a
   *  barcode/pasted-URL hit up to its group-level identity. */
  masterId: number | null;
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
    master_id?: number;
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
    masterId: data.master_id ?? null,
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
  /** The master this release belongs to, if any. */
  masterId: number | null;
  title: string;
  artistName: string;
  year: number | null;
  format: string | null;
  coverUrl: string | null;
}

/**
 * Resolve a barcode via Discogs' own database search — the sole barcode
 * path (MusicBrainz has been removed). A barcode can legitimately be shared
 * by several colour-vinyl/regional variants of the same release (label
 * barcode reuse, not a data error) — there's no reliable way to pick the
 * "right" one from the barcode alone, so this takes the first result whose
 * own barcode list actually contains an exact match. Track content is
 * identical across such variants either way; only the cover art might not
 * exactly match the specific one owned.
 *
 * IMPORTANT: Discogs' `barcode=` search parameter is NOT an exact-match
 * filter — an unassigned/garbage barcode still returns millions of
 * loosely-relevant "hits" (it silently falls back to full-text search
 * across matrix/runout numbers, label codes, etc. once nothing matches as a
 * barcode). Blindly trusting the top result would misidentify almost every
 * non-matching scan, so every candidate's own barcode array is checked here
 * for an exact digit-normalized match before it's accepted.
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
  // cover_image are often blank) — the full release fetch has both properly,
  // and also gives us master_id for group-level identity.
  const release = await fetchDiscogsRelease(verified.id);
  return {
    discogsReleaseId: verified.id,
    masterId: release.masterId,
    title: release.title,
    artistName: release.artistName,
    year: release.year,
    format: release.format,
    coverUrl: release.coverUrl,
  };
}

/**
 * Barcodes come from a camera scanner or manual typing, so strip everything
 * but digits (whitespace, scanner-injected control chars) before using one
 * as a lookup key. Returns null for anything that isn't a plausible
 * UPC/EAN length (8, 12, 13 or 14 digits).
 */
export function normalizeBarcode(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

/**
 * iTunes sanitises characters that aren't legal in file/folder names — "/"
 * and ":" become "_" and ";" respectively. There's no reliable way to tell
 * that apart from genuine underscores/semicolons in an artist's real name,
 * so we try the folder name as-is first, then a reversed-sanitisation
 * fallback. Classical multi-credit folders (several soloists joined by
 * "_"/";" that were never a single "/"-joined name to begin with) may match
 * neither — that's an accepted gap.
 */
export function artistNameVariants(folderDerivedName: string): string[] {
  const variants = [folderDerivedName];
  const reversed = folderDerivedName.replace(/_/g, "/").replace(/;/g, ":");
  if (reversed !== folderDerivedName) variants.push(reversed);
  return variants;
}

function normalizeArtistName(name: string): string {
  return normalizeTitle(name);
}

// Strip bracket/paren "tag" suffixes (edition/live/remaster annotations)
// before the generic normalizeTitle pass, which already folds "_" and "/"
// to the same space character.
const TAG_RE = /[[(][^\])]*[\])]/g;

// Discogs titles a release with a non-Latin-script pressing as
// "<title> = <translated/transliterated title>" (e.g. "Flowers = 花朵") —
// but WHICH side is the Latin one is not consistent: a Korean/Chinese-market
// pressing lists it "Flowers = 花朵" (Latin first), while a Japanese-market
// one commonly lists it "幻想惑星 = Oxygene" (native script FIRST, the
// internationally-known Latin title second). A real bug from blindly
// stripping the right-hand side: Jean-Michel Jarre's "Oxygène" master came
// back from a search hit titled "幻想惑星 = Oxygene" and got stored/compared
// as "幻想惑星" — the wrong side — so it silently never matched the owned
// album at all. Detect and keep whichever side is actually Latin-script.
const NON_LATIN_SCRIPT_RE =
  /[぀-ヿ㐀-䶿一-鿿가-힣֐-׿؀-ۿݐ-ݿЀ-ӿ฀-๿]/;

function isLatinScript(s: string): boolean {
  return !NON_LATIN_SCRIPT_RE.test(s);
}

/** Given a raw Discogs title that may carry a "<title> = <title>" pairing,
 *  return whichever side is Latin-script (both/neither Latin -> the left,
 *  same as the string's own primary listing). No "=" present -> unchanged. */
export function preferLatinTitle(raw: string): string {
  const eqIdx = raw.indexOf(" = ");
  if (eqIdx === -1) return raw;
  const left = raw.slice(0, eqIdx).trim();
  const right = raw.slice(eqIdx + 3).trim();
  if (isLatinScript(left) && !isLatinScript(right)) return left;
  if (isLatinScript(right) && !isLatinScript(left)) return right;
  return left;
}

export function normalizeAlbumTitle(title: string): string {
  return normalizeTitle(preferLatinTitle(title).replace(TAG_RE, " "));
}

/**
 * Classify a Discogs discography entry's kind from its format descriptor
 * string (e.g. "Vinyl, LP, Album", "CD, Compilation") and title. Discogs has
 * no clean primary/secondary-type pair the way MusicBrainz's release-groups
 * did — this is a real, acknowledged precision regression: format strings
 * don't reliably distinguish live/remix/soundtrack releases the way
 * MusicBrainz's secondary types did, so title heuristics do that work
 * instead (same heuristics this app already used as MusicBrainz's own
 * unmatched-leftover fallback).
 */
export function classifyDiscogsKind(title: string, format: string | null): AlbumKind {
  const fmt = (format ?? "").toLowerCase();
  if (fmt.includes("compilation")) return "COMPILATION";
  if (/\blive\b/i.test(title)) return "LIVE";
  if (/\bremix/i.test(title)) return "REMIX";
  if (/\bsoundtrack\b/i.test(title)) return "SOUNDTRACK";
  if (fmt.includes("ep")) return "EP";
  if (fmt.includes("album")) return "STUDIO";
  return "OTHER";
}

// --- Artist matching ---

interface DiscogsArtistSearchHit {
  id: number;
  name: string;
}

async function searchDiscogsArtistHits(name: string): Promise<DiscogsArtistSearchHit[]> {
  const data = (await discogsFetch("/database/search", { q: name, type: "artist" })) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results?: any[];
  };
  return (data.results ?? []).slice(0, 10).map((r) => ({ id: r.id, name: r.title ?? "" }));
}

interface ArtistMatch {
  discogsId: number;
  name: string;
  confidence: "EXACT" | "SEARCH" | "LOW";
}

/**
 * Mimics pickHit() in tmdb.ts: prefer an exact normalized-name match among
 * the top results; otherwise fall back to Discogs' own top-ranked hit when
 * it's the only plausible one. Tried against the folder name as-is first,
 * then (if nothing usable) the reversed-sanitisation variant. Unlike
 * MusicBrainz's search, Discogs returns no relevance score — an unambiguous
 * single non-exact top hit is trusted at SEARCH/LOW grade instead of using a
 * score threshold; multiple non-exact hits are treated as too ambiguous to
 * trust and this variant is skipped.
 */
async function matchArtist(folderDerivedName: string): Promise<ArtistMatch | null> {
  const variants = artistNameVariants(folderDerivedName);
  const want = normalizeArtistName(folderDerivedName);

  for (let i = 0; i < variants.length; i++) {
    const isPrimary = i === 0;
    const results = await searchDiscogsArtistHits(variants[i]);
    if (!results.length) continue;

    const exact = results.find((r) => normalizeArtistName(r.name) === want);
    if (exact) {
      return { discogsId: exact.id, name: exact.name, confidence: isPrimary ? "EXACT" : "SEARCH" };
    }

    if (results.length === 1) {
      return { discogsId: results[0].id, name: results[0].name, confidence: isPrimary ? "SEARCH" : "LOW" };
    }
  }
  return null;
}

// --- Discography listing ---

export interface DiscographyEntry {
  id: number;
  type: "master" | "release";
  title: string;
  year: number | null;
  kind: AlbumKind;
}

// Discogs' search result `title` is typically "Artist - Title" — split on
// the first " - " to recover both; if absent, the whole string is the
// title and the artist is left generic (matches only what the API gives).
function splitArtistTitle(combined: string): { artistName: string; title: string } {
  const idx = combined.indexOf(" - ");
  if (idx === -1) return { artistName: "Unknown Artist", title: combined };
  return { artistName: combined.slice(0, idx).trim(), title: combined.slice(idx + 3).trim() };
}

// Discogs' format filter doesn't have Live/Remix/Soundtrack buckets, so
// entries found under the "Album" bucket get a title-heuristic pass to
// refine the default STUDIO classification — same heuristics this app
// already used as MusicBrainz's own unmatched-leftover fallback.
function classifyKindFromTitle(title: string): AlbumKind {
  if (/\blive\b/i.test(title)) return "LIVE";
  if (/\bremix/i.test(title)) return "REMIX";
  if (/\bsoundtrack\b/i.test(title)) return "SOUNDTRACK";
  return "STUDIO";
}

// Discogs' per-artist releases endpoint (/artists/{id}/releases) returns
// EVERY release/master credited to the artist with role "Main" — for a
// working pop act that's thousands of entries (singles, promos, regional
// pressings, other-artist collabs), and critically, `master`-type entries
// from THAT endpoint carry no format/genre info at all, making reliable
// STUDIO/EP classification impossible without an extra fetch per entry
// (infeasible at scale — some artists have hundreds of masters).
//
// This uses /database/search instead, with Discogs' own server-side
// `format` filter (format=Album, format=EP) — the search index DOES
// return format + master_id per hit, so classification and dedup both come
// for free without per-entry fetches. Capped at MAX_DISCOGRAPHY_PAGES per
// bucket: a prolific/decades-reissued artist can have hundreds of pressings
// of the same handful of albums (Ace Of Base: 638 "Album"-format search
// hits collapsing to ~6 real albums) — every additional pressing found
// after the first is redundant for identity purposes, so the marginal rate
// of NEW distinct master/release ids drops off fast well before the cap.
// Kept deliberately low (200 results, not the 500 a higher cap would allow)
// for a second reason beyond cost: `artist=<name>` has no numeric-id
// equivalent on this endpoint (Discogs' search API doesn't support
// artist-id scoping at all), so it's a free-text name match — a common
// name (e.g. "Aqua") pulls in wholly unrelated artists sharing it once the
// genuinely relevant, higher-ranked results run out. Discogs' own
// relevance ranking puts the actual searched artist's material first, so a
// tighter cap trades a little recall on obscure regional editions (same
// "bounded, not exhaustive" trade-off already accepted elsewhere in this
// module, see searchDiscogsTitleFallback) for meaningfully less
// same-name-collision noise in the results.
const MAX_DISCOGRAPHY_PAGES = 2;
const DISCOGRAPHY_PAGE_SIZE = 100;

interface DiscographySearchHit {
  releaseId: number;
  masterId: number | null;
  title: string;
  year: number | null;
}

async function searchDiscogsReleasesByFormat(
  artistName: string,
  format: "Album" | "EP" | "Compilation",
): Promise<DiscographySearchHit[]> {
  const out: DiscographySearchHit[] = [];
  for (let page = 1; page <= MAX_DISCOGRAPHY_PAGES; page++) {
    const data = (await discogsFetch("/database/search", {
      artist: artistName,
      type: "release",
      format,
      per_page: String(DISCOGRAPHY_PAGE_SIZE),
      page: String(page),
    })) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results?: any[];
      pagination?: { pages?: number };
    };
    const batch = data.results ?? [];
    for (const r of batch) {
      out.push({ releaseId: r.id, masterId: r.master_id ?? null, title: r.title ?? "Untitled", year: r.year ? Number(r.year) : null });
    }
    const totalPages = data.pagination?.pages ?? 1;
    if (page >= totalPages || batch.length === 0) break;
  }
  return out;
}

function hitKey(hit: DiscographySearchHit): string {
  return hit.masterId != null ? `master:${hit.masterId}` : `release:${hit.releaseId}`;
}

/**
 * An artist's discography, deduped to one entry per master (or per
 * standalone release when a pressing has no master — not every Discogs
 * release does) — the group-listing analog of MusicBrainz's release-group
 * search. Three format buckets, in this specific order — Album
 * (title-heuristic-refined to LIVE/REMIX/SOUNDTRACK, else STUDIO), EP, then
 * Compilation LAST — with a master/release already claimed by an earlier
 * bucket never re-added or reclassified by a later one.
 *
 * That ordering is deliberate and safety-critical, not cosmetic: an earlier
 * version searched Compilation FIRST and let it override everything else,
 * on the theory that Discogs tags real compilations with both "Album" and
 * "Compilation" so only a dedicated exclusion search could catch them
 * reliably. It backfired — Discogs' per-PRESSING format tags are
 * inconsistent within the same master (a deluxe reissue bundling bonus
 * tracks often picks up a "Compilation" descriptor a contributor added,
 * while the plain original release never was one), and since every
 * pressing of a master collapses to one entry, one mistagged reissue was
 * enough to flip flagship studio albums — Blur's "13"/"Blur"/"Parklife",
 * Aqua's "Aquarium" — outright to COMPILATION. Searching Compilation LAST
 * and additively (only filling in a master the Album/EP buckets never
 * found at all) gets the real win — genuine compilations ("Best Of Bowie",
 * Eurythmics' "Greatest Hits") — without that risk: a master already
 * claimed as STUDIO via the Album bucket is locked in before the
 * Compilation search ever runs, so a mistagged reissue of it can no longer
 * touch it. See MAX_DISCOGRAPHY_PAGES below for the bounded-pagination
 * trade-off shared by all three buckets.
 */
export async function fetchArtistReleases(artistName: string): Promise<DiscographyEntry[]> {
  const seenKeys = new Set<string>();
  const entries: DiscographyEntry[] = [];

  function addHits(hits: DiscographySearchHit[], kind: AlbumKind, titleHeuristic: boolean) {
    for (const hit of hits) {
      const key = hitKey(hit);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      // Same Latin-side preference as normalizeAlbumTitle (see
      // preferLatinTitle) — this is the title actually stored on Album
      // rows, so a placeholder's display title should be the Latin one
      // regardless of which side of "=" Discogs happened to list it on.
      const { title: rawTitle } = splitArtistTitle(hit.title);
      const title = preferLatinTitle(rawTitle);
      const type: "master" | "release" = hit.masterId != null ? "master" : "release";
      entries.push({ id: hit.masterId ?? hit.releaseId, type, title, year: hit.year, kind: titleHeuristic ? classifyKindFromTitle(title) : kind });
    }
  }

  addHits(await searchDiscogsReleasesByFormat(artistName, "Album"), "STUDIO", true);
  addHits(await searchDiscogsReleasesByFormat(artistName, "EP"), "EP", false);
  addHits(await searchDiscogsReleasesByFormat(artistName, "Compilation"), "COMPILATION", false);
  return entries;
}

/**
 * Free-text discography search for the scan page's "Search by title"
 * fallback — no barcode involved, so this is Discogs' own relevance
 * ranking rather than an exact match. Searches masters first (the closer
 * analog to MusicBrainz's release-groups); if that comes back empty, falls
 * back to standalone releases (small-run pressings with no master).
 */
export interface DiscogsTitleSearchAlbum {
  discogsMasterId: number | null;
  discogsReleaseId: number | null;
  title: string;
  artistName: string;
  year: number | null;
  coverArtUrl: string | null;
}

async function searchDiscogsTitle(
  title: string,
  artist: string | undefined,
  type: "master" | "release",
): Promise<DiscogsTitleSearchAlbum[]> {
  const params: Record<string, string> = { q: artist ? `${artist} ${title}` : title, type };
  const data = (await discogsFetch("/database/search", params)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results?: any[];
  };
  return (data.results ?? []).slice(0, 5).map((r) => {
    const { artistName, title: parsedTitle } = splitArtistTitle(r.title ?? "");
    return {
      discogsMasterId: type === "master" ? r.id : null,
      discogsReleaseId: type === "release" ? r.id : null,
      title: parsedTitle,
      artistName,
      year: r.year ? Number(r.year) : null,
      coverArtUrl: r.cover_image || r.thumb || null,
    };
  });
}

export async function searchDiscogsTitleFallback(title: string, artist?: string): Promise<DiscogsTitleSearchAlbum[]> {
  const masters = await searchDiscogsTitle(title, artist, "master");
  if (masters.length > 0) return masters;
  return searchDiscogsTitle(title, artist, "release");
}

// --- Album identity lookup ---

/** Exactly one of discogsMasterId/discogsReleaseId is ever meaningfully set
 *  on an Album — Prisma has no single-query "unique on either of two
 *  columns," so this wraps the OR lookup every identity-keyed call site
 *  needs. */
export async function findAlbumByDiscogsIdentity(identity: {
  discogsMasterId: number | null;
  discogsReleaseId: number | null;
}) {
  if (identity.discogsMasterId == null && identity.discogsReleaseId == null) return null;
  return prisma.album.findFirst({
    where: {
      OR: [
        ...(identity.discogsMasterId != null ? [{ discogsMasterId: identity.discogsMasterId }] : []),
        ...(identity.discogsReleaseId != null ? [{ discogsReleaseId: identity.discogsReleaseId }] : []),
      ],
    },
  });
}

// --- Cover art pass (shared by matched and various=true artists) ---

async function fetchMissingCoversForArtist(artistId: number, artistName: string, log: string[]): Promise<void> {
  // coverSource "manual" is an owner-curated override — never revisited here.
  const needCovers = await prisma.album.findMany({
    where: { artistId, coverPath: null },
  });
  for (const album of needCovers) {
    try {
      // Album-level cover resolution goes straight from embedded art to
      // iTunes (see fetchCover) — Discogs cover backfill happens
      // opportunistically via populatePhysicalReleaseFromDiscogs when a
      // pressing is linked, not as a standalone album-level tier.
      const result = await fetchCover({
        id: album.id,
        title: album.title,
        artistName,
        owned: album.owned,
        coverSource: album.coverSource,
      });
      if (result) {
        await prisma.album.update({
          where: { id: album.id },
          data: { coverPath: result.fileName, coverSource: result.source },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Cover art fetch failed for "${album.title}" (${artistName}): ${message}`);
    }
  }
}

// --- Album reconciliation ---

// When two discography entries share a normalized title (real case: Linkin
// Park's "Hybrid Theory" studio album vs the band's 1999 "Hybrid Theory"
// EP), the owned album must be claimed by the best-ranked kind, not
// whichever the search happened to return first.
const KIND_CLAIM_ORDER: AlbumKind[] = ["STUDIO", "EP", "LIVE", "COMPILATION", "REMIX", "SOUNDTRACK", "OTHER"];
function discographyEntryKindRank(entry: DiscographyEntry): number {
  const idx = KIND_CLAIM_ORDER.indexOf(entry.kind);
  return idx === -1 ? KIND_CLAIM_ORDER.length : idx;
}

function entryKey(entry: DiscographyEntry): string {
  return `${entry.type}:${entry.id}`;
}

function identityKeyOf(a: { discogsMasterId: number | null; discogsReleaseId: number | null }): string | null {
  if (a.discogsMasterId != null) return `master:${a.discogsMasterId}`;
  if (a.discogsReleaseId != null) return `release:${a.discogsReleaseId}`;
  return null;
}

function entryIdentity(entry: DiscographyEntry): { discogsMasterId: number | null; discogsReleaseId: number | null } {
  return entry.type === "master"
    ? { discogsMasterId: entry.id, discogsReleaseId: null }
    : { discogsMasterId: null, discogsReleaseId: entry.id };
}

type OwnedAlbumRow = {
  id: number;
  title: string;
  discogsMasterId: number | null;
  discogsReleaseId: number | null;
  kind: string;
  coverSource: string | null;
};

async function reconcileArtistAlbums(artistId: number, artistName: string, log: string[]): Promise<void> {
  const releases = (await fetchArtistReleases(artistName)).sort(
    (a, b) => discographyEntryKindRank(a) - discographyEntryKindRank(b),
  );
  const entryByKey = new Map(releases.map((e) => [entryKey(e), e]));
  const ownedAlbums: OwnedAlbumRow[] = await prisma.album.findMany({
    where: { artistId, owned: true },
    select: { id: true, title: true, discogsMasterId: true, discogsReleaseId: true, kind: true, coverSource: true },
  });

  const claimedEntryKeys = new Set<string>();
  const claimedOwnedIds = new Set<number>();

  // Pre-pass — ordinal disambiguation for identically-titled discography
  // entries. Some artists have several albums with the SAME title (Peter
  // Gabriel's first four are all "Peter Gabriel"); the owner's folders
  // disambiguate with a numeric tag — "Peter Gabriel (3)" — which
  // normalizeAlbumTitle strips, making the bare title-match pairing
  // arbitrary. When an owned album carries a trailing "(N)"/"[N]" and 2+
  // discography entries share its normalized title, treat N as a 1-based
  // index into that group's best-kind subset, date-sorted and deduped to
  // ONE entry per release year.
  //
  // Assignments are computed for the whole artist first and applied in two
  // phases (clear identity for the whole batch, then set the new ones)
  // because members can swap discography entries with each other —
  // updating in place trips the unique constraint mid-swap.
  const entriesByNormTitle = new Map<string, typeof releases>();
  for (const e of releases) {
    const t = normalizeAlbumTitle(e.title ?? "");
    const arr = entriesByNormTitle.get(t);
    if (arr) arr.push(e);
    else entriesByNormTitle.set(t, [e]);
  }
  const ordinalBatch: { album: OwnedAlbumRow; entry: DiscographyEntry }[] = [];
  const batchTargetKeys = new Set<string>();
  for (const a of ownedAlbums) {
    const ordMatch = /[([](\d{1,2})[)\]]\s*$/.exec(a.title);
    if (!ordMatch) continue;
    const ordinal = Number(ordMatch[1]);
    const group = entriesByNormTitle.get(normalizeAlbumTitle(a.title));
    if (!group || group.length < 2) continue;
    const bestRank = Math.min(...group.map(discographyEntryKindRank));
    const seenYears = new Set<string>();
    const candidates: DiscographyEntry[] = [];
    for (const e of group
      .filter((e) => discographyEntryKindRank(e) === bestRank)
      .slice()
      .sort((x, y) => (x.year ?? 9999) - (y.year ?? 9999))) {
      const yr = String(e.year ?? "?");
      if (seenYears.has(yr)) continue;
      seenYears.add(yr);
      candidates.push(e);
    }
    const entry = candidates[ordinal - 1];
    if (!entry || batchTargetKeys.has(entryKey(entry))) continue;
    ordinalBatch.push({ album: a, entry });
    batchTargetKeys.add(entryKey(entry));
  }
  if (ordinalBatch.length > 0) {
    const batchAlbumIds = new Set(ordinalBatch.map((b) => b.album.id));
    // Phase 0: resolve outside holders of our target entries — reclaim
    // placeholders, and skip any member whose target is held by an owned
    // album that isn't itself being reassigned (left for review).
    const applicable: typeof ordinalBatch = [];
    for (const b of ordinalBatch) {
      const holder = await findAlbumByDiscogsIdentity(entryIdentity(b.entry));
      if (holder && holder.id !== b.album.id && !batchAlbumIds.has(holder.id)) {
        if (!holder.owned) {
          await prisma.album.delete({ where: { id: holder.id } });
        } else {
          log.push(
            `Ordinal match for "${b.album.title}" (${artistName}) skipped — Discogs ${b.entry.type} ${b.entry.id} is held by owned "${holder.title}"`,
          );
          continue;
        }
      }
      applicable.push(b);
    }
    // Phase 1: free the unique constraints across the whole batch.
    for (const b of applicable) {
      if (identityKeyOf(b.album) !== null && identityKeyOf(b.album) !== entryKey(b.entry)) {
        await prisma.album.update({ where: { id: b.album.id }, data: { discogsMasterId: null, discogsReleaseId: null } });
      }
    }
    // Phase 2: apply the assignments.
    for (const b of applicable) {
      const kind = b.entry.kind;
      const identity = entryIdentity(b.entry);
      const invalidateCover =
        identityKeyOf(b.album) !== null &&
        identityKeyOf(b.album) !== entryKey(b.entry) &&
        b.album.coverSource !== "embedded" &&
        b.album.coverSource !== "manual";
      await prisma.album.update({
        where: { id: b.album.id },
        data: {
          ...identity,
          year: b.entry.year,
          releaseDate: b.entry.year ? new Date(Date.UTC(b.entry.year, 0, 1)) : null,
          kind,
          ...(invalidateCover ? { coverPath: null, coverSource: null } : {}),
        },
      });
      claimedEntryKeys.add(entryKey(b.entry));
      claimedOwnedIds.add(b.album.id);
      b.album.discogsMasterId = identity.discogsMasterId;
      b.album.discogsReleaseId = identity.discogsReleaseId;
      b.album.kind = kind;
      log.push(`Ordinal-matched "${b.album.title}" (${artistName}) to Discogs ${b.entry.type} ${b.entry.id} (${b.entry.year ?? "?"})`);
    }
  }

  // Pass 1: attach identity/year/releaseDate/kind to owned albums, matched
  // either by an identity already recorded from a prior run (idempotent) or
  // by normalized title.
  for (const entry of releases) {
    // An entry claimed by the ordinal pre-pass (or earlier in this loop) is
    // settled — without this guard the worse-kind re-claim below could try
    // to move a second album onto it and trip a unique constraint.
    if (claimedEntryKeys.has(entryKey(entry))) continue;
    const kind = entry.kind;
    const wantTitle = normalizeAlbumTitle(entry.title ?? "");

    const titleMatches = (a: { title: string }) =>
      normalizeAlbumTitle(a.title) === wantTitle || normalizeAlbumTitle(`${artistName} ${a.title}`) === wantTitle;

    let reclaimedFromWorseKind = false;
    let owned = ownedAlbums.find((a) => !claimedOwnedIds.has(a.id) && identityKeyOf(a) === entryKey(entry));
    if (!owned) {
      // Also try the folder title prefixed with the artist name: discography
      // entries are often titled "<Artist>: <Album>" where the folder is
      // just "<Album>".
      owned = ownedAlbums.find((a) => !claimedOwnedIds.has(a.id) && identityKeyOf(a) === null && titleMatches(a));
    }
    if (!owned) {
      // Self-heal a prior wrong claim: this entry's title matches an album
      // that is currently attached to a WORSE-ranked entry with the same
      // ambiguous title (the Hybrid Theory studio/EP case). Re-claim it
      // here — entries iterate best-kind-first, so this entry wins.
      owned = ownedAlbums.find((a) => {
        if (claimedOwnedIds.has(a.id)) return false;
        const key = identityKeyOf(a);
        if (key === null || key === entryKey(entry)) return false;
        const prevEntry = entryByKey.get(key);
        if (!prevEntry || discographyEntryKindRank(prevEntry) <= discographyEntryKindRank(entry)) return false;
        return titleMatches(a);
      });
      if (owned) {
        reclaimedFromWorseKind = true;
        const prevEntry = entryByKey.get(identityKeyOf(owned)!);
        log.push(
          `Re-claimed "${owned.title}" (${artistName}) from ${prevEntry?.kind ?? "?"} Discogs ${identityKeyOf(owned)} to ${kind} ${entry.type} ${entry.id}`,
        );
      }
    }
    if (!owned) continue;

    claimedEntryKeys.add(entryKey(entry));
    claimedOwnedIds.add(owned.id);

    if (identityKeyOf(owned) !== entryKey(entry)) {
      // Another row may already hold this entry's identity: a missing-album
      // placeholder from a prior run (reclaim it — the album on disk takes
      // its place) or a genuine second owned album (never merge on a title
      // match alone — flag it and leave both untouched). Must run for
      // re-claims too, not just first-time matches.
      const holder = await findAlbumByDiscogsIdentity(entryIdentity(entry));
      if (holder && holder.id !== owned.id) {
        if (!holder.owned) {
          await prisma.album.delete({ where: { id: holder.id } });
          log.push(`Reclaimed missing-album placeholder "${holder.title}" for "${artistName}" — "${owned.title}" is on disk`);
        } else {
          log.push(
            `Match conflict: "${owned.title}" and "${holder.title}" (${artistName}) both normalize to Discogs ${entry.type} ${entry.id} — left unmatched for review`,
          );
          continue;
        }
      }
    }

    // A re-claim means the previously fetched cover belongs to the WRONG
    // entry — invalidate it so the cover pass re-fetches, unless it came
    // from the file's own embedded art or a manual pick.
    const invalidateCover = reclaimedFromWorseKind && owned.coverSource !== "embedded" && owned.coverSource !== "manual";
    const identity = entryIdentity(entry);
    await prisma.album.update({
      where: { id: owned.id },
      data: {
        ...identity,
        year: entry.year,
        releaseDate: entry.year ? new Date(Date.UTC(entry.year, 0, 1)) : null,
        kind,
        ...(invalidateCover ? { coverPath: null, coverSource: null } : {}),
      },
    });
    // Keep the in-memory row consistent so a worse-ranked entry later in
    // this loop can't find the stale identity and claim the album back.
    owned.discogsMasterId = identity.discogsMasterId;
    owned.discogsReleaseId = identity.discogsReleaseId;
    owned.kind = kind;
  }

  // Owned albums that matched no discography entry at all keep the
  // scanner's default kind STUDIO, which pollutes the studio timeline. A
  // "live" in the title is a strong enough signal to reclassify just those
  // leftovers; everything else stays STUDIO, and a later successful match
  // overwrites the heuristic anyway.
  for (const a of ownedAlbums) {
    if (claimedOwnedIds.has(a.id) || identityKeyOf(a) !== null || a.kind !== "STUDIO") continue;
    if (/\blive\b/i.test(a.title)) {
      await prisma.album.update({ where: { id: a.id }, data: { kind: "LIVE" } });
      log.push(`Reclassified unmatched "${a.title}" (${artistName}) as LIVE by title heuristic`);
    } else if (/\b(best of|greatest hits|golden greats|the hits|singles|collection|anthology)\b/i.test(a.title)) {
      await prisma.album.update({ where: { id: a.id }, data: { kind: "COMPILATION" } });
      log.push(`Reclassified unmatched "${a.title}" (${artistName}) as COMPILATION by title heuristic`);
    }
  }

  // studioTotal is recorded regardless of whether gap tracking qualifies
  // below — it's what lets the UI show an honest "1/282 owned" instead of
  // "1/1".
  const studioEntries = releases.filter((e) => e.kind === "STUDIO");
  const studioTotal = studioEntries.length;
  await prisma.artist.update({ where: { id: artistId }, data: { studioTotal } });

  // Gap-tracking gate: only create/maintain owned=false placeholders once
  // we own enough of the artist to be worth completing.
  const ownedStudioCount = await prisma.album.count({ where: { artistId, owned: true, kind: "STUDIO" } });
  const qualifies =
    studioTotal > 0 && ownedStudioCount >= MUSIC_GAP_MIN_OWNED && ownedStudioCount / studioTotal >= MUSIC_GAP_MIN_PCT;

  if (!qualifies) {
    const removed = await prisma.album.deleteMany({
      where: { artistId, owned: false, physicalCopies: { none: {} } },
    });
    if (removed.count > 0) {
      log.push(`Removed ${removed.count} back-catalogue placeholder(s) for "${artistName}" — gap tracking off`);
    }
    log.push(`Gap tracking off for "${artistName}": owns ${ownedStudioCount} of ${studioTotal} studio albums`);
    await fetchMissingCoversForArtist(artistId, artistName, log);
    return;
  }

  // Identity-less placeholders left behind by the MusicBrainz-to-Discogs
  // cutover (every back-catalogue placeholder this app ever created before
  // that migration has no discogsMasterId/discogsReleaseId at all) —
  // findAlbumByDiscogsIdentity can never find these by identity, so without
  // this map every one of them would silently orphan while pass 2 below
  // creates a fresh duplicate placeholder alongside it. Matched by
  // normalized title, same as pass 1's owned-album reclaim; consumed
  // (deleted from the map) as each is claimed so two entries that happen to
  // normalize the same can't both grab it.
  const orphanPlaceholdersByTitle = new Map<
    string,
    { id: number; title: string }
  >();
  for (const p of await prisma.album.findMany({
    where: { artistId, owned: false, discogsMasterId: null, discogsReleaseId: null },
    select: { id: true, title: true },
  })) {
    orphanPlaceholdersByTitle.set(normalizeAlbumTitle(p.title), p);
  }

  // Pass 2: create owned=false placeholders for STUDIO entries we don't own.
  for (const entry of studioEntries) {
    if (claimedEntryKeys.has(entryKey(entry))) continue;

    const identity = entryIdentity(entry);
    const existing = await findAlbumByDiscogsIdentity(identity);
    if (existing) {
      if (existing.owned) continue; // reconciled in pass 1 by another path — leave alone
      await prisma.album.update({
        where: { id: existing.id },
        data: {
          title: entry.title,
          sortTitle: sortTitle(entry.title),
          year: entry.year,
          releaseDate: entry.year ? new Date(Date.UTC(entry.year, 0, 1)) : null,
          kind: "STUDIO",
        },
      });
      continue;
    }

    const orphan = orphanPlaceholdersByTitle.get(normalizeAlbumTitle(entry.title));
    if (orphan) {
      orphanPlaceholdersByTitle.delete(normalizeAlbumTitle(entry.title));
      await prisma.album.update({
        where: { id: orphan.id },
        data: {
          title: entry.title,
          sortTitle: sortTitle(entry.title),
          year: entry.year,
          releaseDate: entry.year ? new Date(Date.UTC(entry.year, 0, 1)) : null,
          ...identity,
          kind: "STUDIO",
        },
      });
      continue;
    }

    await prisma.album.create({
      data: {
        artistId,
        title: entry.title,
        sortTitle: sortTitle(entry.title),
        year: entry.year,
        releaseDate: entry.year ? new Date(Date.UTC(entry.year, 0, 1)) : null,
        ...identity,
        kind: "STUDIO",
        owned: false,
        folder: null,
      },
    });
    log.push(`Added missing studio album "${entry.title}"${entry.year ? ` (${entry.year})` : ""} for "${artistName}"`);
  }

  // Pass 3: delete owned=false placeholders whose discography entry
  // vanished from this run's STUDIO listing.
  const seenStudioKeys = new Set(studioEntries.map(entryKey));
  const stalePlaceholders = await prisma.album.findMany({
    where: {
      artistId,
      owned: false,
      physicalCopies: { none: {} },
      OR: [{ discogsMasterId: { not: null } }, { discogsReleaseId: { not: null } }],
    },
    select: { id: true, title: true, discogsMasterId: true, discogsReleaseId: true },
  });
  for (const stale of stalePlaceholders) {
    const key = identityKeyOf(stale);
    if (key && !seenStudioKeys.has(key)) {
      await prisma.album.delete({ where: { id: stale.id } });
      log.push(`Removed vanished back-catalogue placeholder "${stale.title}" for "${artistName}"`);
    }
  }

  await fetchMissingCoversForArtist(artistId, artistName, log);
}

// --- Per-artist driver ---

/**
 * Roon-style bio/photo/backdrop, best-effort — see fetchArtistEnrichment.
 * TheAudioDB and Fanart.tv are keyed by a MusicBrainz artist id, which no
 * longer exists in this app — always passes null, which fetchArtistEnrichment
 * already treats as "skip those tiers, Wikipedia-by-name only" (a known,
 * accepted regression from the MusicBrainz-to-Discogs cutover, left
 * out of scope for this migration — see PLAN.md).
 */
async function enrichArtistBioAndImages(artistId: number, artistName: string, log: string[]): Promise<void> {
  const current = await prisma.artist.findUnique({
    where: { id: artistId },
    select: { bio: true, bioSource: true, photoPath: true, photoSource: true, backdropPath: true, backdropSource: true },
  });
  if (!current) return;

  const needsBio = current.bioSource !== "manual" && !current.bio;
  const needsPhoto = current.photoSource !== "manual" && !current.photoPath;
  const needsBackdrop = current.backdropSource !== "manual" && !current.backdropPath;
  if (!needsBio && !needsPhoto && !needsBackdrop) return;

  try {
    const result = await fetchArtistEnrichment({ id: artistId, mbid: null, name: artistName, needsBio, needsPhoto, needsBackdrop });
    const data: Record<string, string> = {};
    if (result.bio) {
      data.bio = result.bio.text;
      data.bioSource = result.bio.source;
    }
    if (result.photo) {
      data.photoPath = result.photo.fileName;
      data.photoSource = result.photo.source;
    }
    if (result.backdrop) {
      data.backdropPath = result.backdrop.fileName;
      data.backdropSource = result.backdrop.source;
    }
    if (Object.keys(data).length > 0) {
      await prisma.artist.update({ where: { id: artistId }, data });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Bio/image enrichment failed for "${artistName}": ${message}`);
  }
}

async function enrichOneArtist(artist: Artist, log: string[]): Promise<void> {
  let discogsId = artist.discogsId;

  if (!discogsId || artist.matchConfidence === "UNMATCHED" || artist.matchConfidence === "LOW") {
    const match = await matchArtist(artist.name);
    if (match) {
      const holder = await prisma.artist.findUnique({ where: { discogsId: match.discogsId } });
      if (holder && holder.id !== artist.id) {
        log.push(
          `Match conflict: "${artist.name}" matched Discogs artist "${match.name}" (discogs:${match.discogsId}), already claimed by "${holder.name}" — left unmatched for review`,
        );
      } else {
        await prisma.artist.update({
          where: { id: artist.id },
          data: { discogsId: match.discogsId, matchConfidence: match.confidence },
        });
        discogsId = match.discogsId;
        if (match.confidence === "LOW") {
          log.push(`Low-confidence match: "${artist.name}" -> "${match.name}" (discogs:${match.discogsId})`);
        }
      }
    } else if (!discogsId) {
      log.push(`No Discogs match for artist "${artist.name}"`);
    }
  }

  if (!discogsId) {
    // Stays UNMATCHED — no discography to reconcile against. The cover pass
    // still runs: embedded art needs no Discogs id at all, and a
    // manually-matched album (POST /api/album-match) has its own identity
    // regardless of whether the artist itself is matched.
    await fetchMissingCoversForArtist(artist.id, artist.name, log);
    await enrichArtistBioAndImages(artist.id, artist.name, log);
    return;
  }

  await reconcileArtistAlbums(artist.id, artist.name, log);
  await enrichArtistBioAndImages(artist.id, artist.name, log);
}

async function doMusicEnrich(runId: number): Promise<void> {
  const log: string[] = [];

  const artists = await prisma.artist.findMany({ orderBy: { id: "asc" } });
  const total = artists.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Enriching ${total} artist(s)` });

  let completed = 0;
  for (const artist of artists) {
    try {
      if (artist.various) {
        // Compilations pseudo-artist: skip Discogs artist matching and the
        // back-catalogue listing entirely, but still fetch covers for its
        // owned albums so the artist grid tile isn't blank.
        await fetchMissingCoversForArtist(artist.id, artist.name, log);
      } else {
        await enrichOneArtist(artist, log);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to enrich "${artist.name}": ${message}`);
    }
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message: `Enriched ${completed}/${total}: ${artist.name}` });
    }
  }

  await finishRun(runId, log, `Enriched ${total} artist(s)`);
}

/**
 * Kick off Discogs enrichment. Resolves quickly once the run is registered
 * (or an existing run is found) — the actual work continues in the
 * background and is not awaited here. No API key is required, though
 * setting DISCOGS_TOKEN is strongly recommended before a full-catalogue
 * pass (raises the rate limit from 25/min to 60/min).
 */
export async function runMusicEnrich(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("ENRICH_MUSIC");
  if (!started) return { runId: run.id, started: false };

  doMusicEnrich(run.id).catch(async (err) => {
    console.error("[discogs] enrich failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[discogs] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}

// --- Manual matching (POST /api/album-match) ---

/**
 * Accepts a discogs.com release or master URL (or a bare release id) and
 * applies it as the AUTHORITATIVE identity for this album — overriding
 * whatever the automatic match found, or lack thereof. A master resolves
 * only far enough to pull release-level fields (title/year); its id itself
 * becomes the stored identity, not its main_release.
 *
 * Per the user's explicit requirement, this is a full wipe, not a partial
 * correction: the album's own cover is invalidated (unless embedded/manual)
 * and, crucially, every PhysicalCopy under this album is also reset — those
 * pressing-level Discogs links/covers/tracklists were resolved *in the
 * context of* the old (possibly wrong) album identity, so leaving them in
 * place after correcting the album risks a pressing that points at a
 * release of a different record than the corrected Album row now
 * represents. Hand-entered physical fields (format/catalogNo/label/
 * condition/notes/barcode) describe the physical object itself, independent
 * of which Discogs record it's linked to, and are left untouched.
 */
export async function applyManualAlbumDiscogsMatch(
  albumId: number,
  discogsUrl: string,
): Promise<
  | { ok: true; album: { id: number; title: string; kind: string; year: number | null; discogsUrl: string } }
  | { ok: false; status: number; error: string }
> {
  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) return { ok: false, status: 404, error: "unknown album id" };
  if (!album.owned) return { ok: false, status: 400, error: "cannot manually match a missing-album placeholder" };

  const trimmed = discogsUrl.trim();
  const masterMatch = DISCOGS_MASTER_URL_RE.exec(trimmed);
  const releaseMatch = masterMatch ? null : DISCOGS_URL_RE.exec(trimmed);
  if (!masterMatch && !releaseMatch) {
    return { ok: false, status: 400, error: "expected a discogs.com/release/... or /master/... URL" };
  }

  const isMaster = masterMatch != null;
  const id = Number((masterMatch ?? releaseMatch)![1]);

  // A pasted master URL's id IS the group-level identity directly. A pasted
  // release URL is promoted to ITS master's identity when one exists — same
  // "always normalize to group level when possible" behavior the old
  // MusicBrainz-backed version of this function had (every MB release
  // belonged to exactly one release-group; Discogs masters are optional, so
  // this only promotes when the release actually has one) — otherwise the
  // release's own id is the identity (a standalone pressing with no group).
  let year: number | null;
  let kind: AlbumKind;
  let identity: { discogsMasterId: number | null; discogsReleaseId: number | null };
  try {
    if (isMaster) {
      const mainReleaseId = await fetchDiscogsMasterMainRelease(id);
      const release = await fetchDiscogsRelease(mainReleaseId);
      year = release.year;
      kind = classifyDiscogsKind(release.title, release.format);
      identity = { discogsMasterId: id, discogsReleaseId: null };
    } else {
      const release = await fetchDiscogsRelease(id);
      year = release.year;
      kind = classifyDiscogsKind(release.title, release.format);
      identity = release.masterId != null ? { discogsMasterId: release.masterId, discogsReleaseId: null } : { discogsMasterId: null, discogsReleaseId: id };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `Discogs lookup failed: ${message}` };
  }

  const holder = await findAlbumByDiscogsIdentity(identity);
  if (holder && holder.id !== album.id) {
    if (!holder.owned) {
      await prisma.album.delete({ where: { id: holder.id } });
    } else {
      return { ok: false, status: 409, error: `Discogs ${isMaster ? "master" : "release"} already matched to owned album "${holder.title}"` };
    }
  }

  const identityChanged = identityKeyOf(album) !== identityKeyOf({ discogsMasterId: identity.discogsMasterId, discogsReleaseId: identity.discogsReleaseId });
  const invalidateCover = identityChanged && album.coverPath != null && album.coverSource !== "embedded" && album.coverSource !== "manual";

  const updated = await prisma.album.update({
    where: { id: album.id },
    data: {
      ...identity,
      year: year ?? album.year,
      kind,
      discogsUrl: trimmed,
      ...(invalidateCover ? { coverPath: null, coverSource: null } : {}),
    },
  });

  // Full wipe of pressing-level links resolved under the old identity — see
  // this function's own doc comment. Hand-entered physical fields survive.
  if (identityChanged) {
    const copies = await prisma.physicalCopy.findMany({ where: { albumId: album.id } });
    for (const copy of copies) {
      if (copy.coverSource === "manual") continue;
      await prisma.physicalCopy.update({
        where: { id: copy.id },
        data: { discogsReleaseId: null, discogsUrl: null, coverPath: null, coverSource: null },
      });
      await prisma.physicalTrack.deleteMany({ where: { physicalCopyId: copy.id } });
    }
  }

  return { ok: true, album: { id: updated.id, title: updated.title, kind: updated.kind, year: updated.year, discogsUrl: trimmed } };
}

// --- Physical copies (vinyl, CD, ...) ---

export type PhysicalMedium = "VINYL" | "CD";

export interface PhysicalFields {
  format?: string;
  discs?: number;
  catalogNo?: string;
  label?: string;
  pressYear?: number;
  condition?: string;
  notes?: string;
  barcode?: string;
}

export function physicalCopyData(medium: PhysicalMedium, v: PhysicalFields) {
  return {
    format: v.format || (medium === "VINYL" ? "LP" : "CD"),
    discs: v.discs ?? null,
    catalogNo: v.catalogNo || null,
    label: v.label || null,
    pressYear: v.pressYear ?? null,
    condition: v.condition || null,
    notes: v.notes || null,
    // Omitted entirely (not set to null) when the caller didn't supply one —
    // a manual PhysicalCopyForm edit has no barcode field, and must not wipe
    // out a barcode a scan previously attached to this row.
    ...(v.barcode !== undefined ? { barcode: v.barcode || null } : {}),
    // An explicit save is a confirmation — backfilled rows lose their
    // "inferred" status the moment they're edited by hand.
    inferred: false,
  };
}

async function replacePhysicalTracks(
  copyId: number,
  tracks: { disc: number; trackNumber: number | null; title: string; durationSecs: number | null }[],
): Promise<void> {
  await prisma.physicalTrack.deleteMany({ where: { physicalCopyId: copyId } });
  if (tracks.length > 0) {
    await prisma.physicalTrack.createMany({ data: tracks.map((t) => ({ physicalCopyId: copyId, ...t })) });
  }
}

async function saveCoverIfFound(
  copyId: number,
  result: { fileName: string; source: string } | null,
): Promise<void> {
  if (!result) return;
  await prisma.physicalCopy.update({
    where: { id: copyId },
    data: { coverPath: result.fileName, coverSource: result.source },
  });
}

/**
 * Populate one PhysicalCopy's pressing-specific tracklist and cover art from
 * a known Discogs release id — best-effort throughout (mirrors fetchCover's
 * never-throws contract): a failed track/cover fetch just leaves the copy
 * without them, it never fails the caller's larger operation. Replaces any
 * existing PhysicalTrack rows outright rather than diffing, since a
 * re-attach means the owner is correcting which pressing this copy actually
 * is.
 */
async function populatePhysicalReleaseFromDiscogs(
  copy: { id: number; albumId: number; medium: string; coverSource: string | null },
  discogsReleaseId: number,
): Promise<void> {
  let release: Awaited<ReturnType<typeof fetchDiscogsRelease>> | null = null;
  try {
    release = await fetchDiscogsRelease(discogsReleaseId);
    await replacePhysicalTracks(copy.id, release.tracks);
  } catch {
    // best-effort — a fetch failure just means "no tracks", not partial data
  }
  if (release?.coverUrl) {
    try {
      await saveCoverIfFound(
        copy.id,
        await fetchDiscogsPhysicalCopyCover({
          albumId: copy.albumId,
          medium: copy.medium,
          coverUrl: release.coverUrl,
          coverSource: copy.coverSource,
        }),
      );
    } catch {
      // best-effort — no cover for this pressing, the album's own still shows
    }

    // Back-fill the ALBUM's own cover too when it has none — a physical-only
    // add whose Discogs entry has no usable image found elsewhere would
    // otherwise stay coverless even though a perfectly usable photo was just
    // fetched for the pressing above.
    try {
      const album = await prisma.album.findUnique({
        where: { id: copy.albumId },
        select: { coverPath: true, coverSource: true },
      });
      if (album && !album.coverPath && album.coverSource !== "manual") {
        const result = await fetchDiscogsAlbumCover(copy.albumId, release.coverUrl);
        if (result) {
          await prisma.album.update({
            where: { id: copy.albumId },
            data: { coverPath: result.fileName, coverSource: result.source },
          });
        }
      }
    } catch {
      // best-effort — never fail the larger attach over this
    }
  }
}

/**
 * Link an existing PhysicalCopy (album already in the library, digitally
 * ripped or not) to a specific Discogs release — pulling in that pressing's
 * own tracklist and cover art, which can differ from the album's (a vinyl
 * reissue with a different running order/art than the CD it shares an Album
 * row with). Accepts a discogs.com release/master URL or a bare release id;
 * a master resolves via its main_release for track/cover data, but the
 * PRESSING link stored is that specific release, not the master (a master
 * has no tracklist/cover of its own).
 */
export async function attachPhysicalRelease(
  copyId: number,
  ref: string,
): Promise<{ ok: true; trackCount: number } | { ok: false; status: number; error: string }> {
  const trimmed = ref.trim();

  const masterMatch = DISCOGS_MASTER_URL_RE.exec(trimmed);
  const releaseMatch = masterMatch ? null : DISCOGS_URL_RE.exec(trimmed);

  let discogsReleaseId: number;
  if (masterMatch) {
    try {
      discogsReleaseId = await fetchDiscogsMasterMainRelease(Number(masterMatch[1]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, error: `Discogs lookup failed: ${message}` };
    }
  } else if (releaseMatch) {
    discogsReleaseId = Number(releaseMatch[1]);
  } else if (/^\d+$/.test(trimmed)) {
    discogsReleaseId = Number(trimmed);
  } else {
    return { ok: false, status: 400, error: "expected a discogs.com release/master URL or a bare Discogs release id" };
  }

  const copy = await prisma.physicalCopy.findUnique({ where: { id: copyId } });
  if (!copy) {
    return { ok: false, status: 404, error: "unknown physical copy id" };
  }

  await prisma.physicalCopy.update({
    where: { id: copy.id },
    data: { discogsReleaseId, discogsUrl: `https://www.discogs.com/release/${discogsReleaseId}` },
  });

  await populatePhysicalReleaseFromDiscogs(copy, discogsReleaseId);

  const trackCount = await prisma.physicalTrack.count({ where: { physicalCopyId: copy.id } });
  return { ok: true, trackCount };
}

/**
 * Add a physical-only album from a Discogs release/master URL — for LPs (or
 * unripped CDs) with no digital rip at all, so there's no existing Album row
 * (and possibly no existing Artist row) to attach to the way
 * applyManualAlbumDiscogsMatch does. Creates whatever's missing (Artist
 * folder=null, Album owned=false, same shape as a gap-tracking placeholder)
 * and attaches the PhysicalCopy. If the release turns out to already have an
 * Album row (owned digitally, or an existing back-catalogue placeholder),
 * the copy is just attached to it instead of creating a duplicate.
 */
export async function createPhysicalOnlyAlbum(
  ref: string | { discogsMasterId: number | null; discogsReleaseId: number },
  medium: PhysicalMedium,
  fields: PhysicalFields,
): Promise<
  | { ok: true; album: { id: number; title: string; artistName: string; kind: string; year: number | null } }
  | { ok: false; status: number; error: string }
> {
  // A resolved-identity object bypasses URL parsing entirely — used by the
  // barcode-scan add path, which already knows both the specific pressing
  // (from the barcode match itself) and, separately, whether it belongs to
  // a master, so a URL round-trip would lose that distinction.
  let releaseId: number;
  let explicitMasterId: number | null | undefined;
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    const masterMatch = DISCOGS_MASTER_URL_RE.exec(trimmed);
    const releaseMatch = masterMatch ? null : DISCOGS_URL_RE.exec(trimmed);
    if (!masterMatch && !releaseMatch) {
      return { ok: false, status: 400, error: "expected a discogs.com/release/... or /master/... URL" };
    }
    const isMaster = masterMatch != null;
    const id = Number((masterMatch ?? releaseMatch)![1]);
    try {
      releaseId = isMaster ? await fetchDiscogsMasterMainRelease(id) : id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, error: `Discogs lookup failed: ${message}` };
    }
    explicitMasterId = isMaster ? id : undefined;
  } else {
    releaseId = ref.discogsReleaseId;
    explicitMasterId = ref.discogsMasterId;
  }

  let release: DiscogsRelease;
  try {
    release = await fetchDiscogsRelease(releaseId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `Discogs lookup failed: ${message}` };
  }

  // Album identity: an explicit master id (from a pasted master URL, or a
  // barcode hit that already resolved one) wins outright; otherwise promote
  // to the release's own master when it has one (same "normalize to group
  // level when possible" behavior as applyManualAlbumDiscogsMatch — see its
  // own comment), else the release's own id is the identity. The PRESSING
  // attach below always uses releaseId regardless — a master has no
  // tracklist/cover of its own.
  const masterId = explicitMasterId !== undefined ? explicitMasterId : release.masterId;
  const identity: { discogsMasterId: number | null; discogsReleaseId: number | null } =
    masterId != null ? { discogsMasterId: masterId, discogsReleaseId: null } : { discogsMasterId: null, discogsReleaseId: releaseId };

  const existingAlbum = await findAlbumByDiscogsIdentity(identity);
  if (existingAlbum) {
    // Dedup key is the specific pressing, not (album, medium) — multiple
    // copies of the same medium are legal (an original pressing and a later
    // reissue, say), so a retry/duplicate scan of the exact same release is
    // what gets treated as "already logged," not merely sharing a medium.
    const existingCopy = await prisma.physicalCopy.findFirst({
      where: { albumId: existingAlbum.id, medium, discogsReleaseId: releaseId },
    });
    const copy = existingCopy
      ? await prisma.physicalCopy.update({ where: { id: existingCopy.id }, data: { ...physicalCopyData(medium, fields) } })
      : await prisma.physicalCopy.create({
          data: {
            albumId: existingAlbum.id,
            medium,
            discogsReleaseId: releaseId,
            discogsUrl: `https://www.discogs.com/release/${releaseId}`,
            ...physicalCopyData(medium, fields),
          },
        });
    await populatePhysicalReleaseFromDiscogs(copy, releaseId);
    const artist = await prisma.artist.findUnique({ where: { id: existingAlbum.artistId } });
    return {
      ok: true,
      album: {
        id: existingAlbum.id,
        title: existingAlbum.title,
        artistName: artist?.name ?? release.artistName,
        kind: existingAlbum.kind,
        year: existingAlbum.year,
      },
    };
  }

  // Artist identity for a physical-only add: Discogs' release payload has no
  // artist id (only a name), so this only matches an existing artist by
  // normalized name — a genuinely new artist gets created with no discogsId,
  // matched properly on the next Enrich Music pass.
  let artist = await prisma.artist.findFirst({ where: { name: release.artistName } });
  if (!artist) {
    artist = await prisma.artist.create({
      data: {
        name: release.artistName,
        sortName: sortTitle(release.artistName),
        folder: null,
        matchConfidence: "UNMATCHED",
      },
    });
  }

  const kind = classifyDiscogsKind(release.title, release.format);
  const album = await prisma.album.create({
    data: {
      artistId: artist.id,
      title: release.title,
      sortTitle: sortTitle(release.title),
      year: release.year,
      releaseDate: release.year ? new Date(Date.UTC(release.year, 0, 1)) : null,
      ...identity,
      discogsUrl:
        identity.discogsMasterId != null
          ? `https://www.discogs.com/master/${identity.discogsMasterId}`
          : `https://www.discogs.com/release/${releaseId}`,
      kind,
      owned: false,
      folder: null,
    },
  });
  const copy = await prisma.physicalCopy.create({
    data: {
      albumId: album.id,
      medium,
      discogsReleaseId: releaseId,
      discogsUrl: `https://www.discogs.com/release/${releaseId}`,
      ...physicalCopyData(medium, fields),
    },
  });
  await populatePhysicalReleaseFromDiscogs(copy, releaseId);

  // Best-effort cover fetch, same shape as fetchMissingCoversForArtist's
  // per-album try/catch — must never fail the add.
  try {
    const result = await fetchCover({
      id: album.id,
      title: album.title,
      artistName: artist.name,
      owned: false,
      coverSource: null,
    });
    if (result) {
      await prisma.album.update({
        where: { id: album.id },
        data: { coverPath: result.fileName, coverSource: result.source },
      });
    }
  } catch {
    // best-effort; a missing cover is fine, a failed add is not
  }

  return {
    ok: true,
    album: { id: album.id, title: album.title, artistName: artist.name, kind: album.kind, year: album.year },
  };
}
