// MusicBrainz enrichment: match Artist rows to MB artists, pull the studio
// back-catalogue via release-group search, backfill owned Album metadata,
// and create owned=false placeholders for studio albums we don't own yet.
// Mirrors src/lib/tmdb.ts's shape (pickHit-style matching, EXACT/SEARCH/LOW
// confidence, placeholder reclaim, never-merge-except-exact, ScanRun
// progress/log) — see the file-end report for where this deliberately
// diverges and why.
//
// Unlike TMDB, MusicBrainz needs no API key — it's free/open, gated only by
// a 1 req/s global rate limit and a required User-Agent header.

import { prisma } from "@/lib/db";
import { normalizeTitle, sortTitle } from "@/lib/parse";
import type { Artist } from "@/generated/prisma/client";
import type { AlbumKind } from "@/lib/constants";
import { MUSIC_GAP_MIN_OWNED, MUSIC_GAP_MIN_PCT } from "@/lib/constants";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";
import { fetchCover, fetchPhysicalCopyCover, fetchDiscogsPhysicalCopyCover, fetchDiscogsAlbumCover } from "@/lib/cover-art";
import { DISCOGS_URL_RE, fetchDiscogsRelease } from "@/lib/discogs";
import { fetchArtistEnrichment } from "@/lib/artist-bio";

// Defaults to the public API; set MUSICBRAINZ_BASE_URL (e.g.
// http://localhost:15000/ws/2) to point at a local musicbrainz-docker mirror
// instead — same Lucene search syntax and JSON shape, so nothing else here
// needs to change. Falls back automatically if unset, so nothing breaks when
// the local mirror isn't running.
const MB_BASE = process.env.MUSICBRAINZ_BASE_URL || "https://musicbrainz.org/ws/2";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";
// MusicBrainz's API ToS caps unauthenticated clients at 1 request/second,
// enforced globally (not per-endpoint) — every ws/2 call funnels through
// mbFetch, which gates on a shared "earliest next call" clock rather than a
// flat post-call sleep (tmdb.ts's approach): TMDB has no stated hard cap, but
// MusicBrainz does, so a fixed-interval scheduler is the safer choice here.
// A self-hosted mirror has no such cap, so the throttle is skipped entirely
// when MB_BASE isn't the public API.
const MIN_INTERVAL_MS = MB_BASE.includes("musicbrainz.org") ? 1000 : 0;
const RG_PAGE_LIMIT = 100;
const PROGRESS_UPDATE_EVERY = 3;
// A transient 503 (MusicBrainz under load) or 429 (rate-limit blip) left the
// artist "Blur" UNMATCHED on a real run — one retry after a fixed backoff is
// enough to ride out a blip without turning a real outage into a hang. The
// 1 req/s gate still applies to the retry (throttle() is called again before
// it), so this never bursts past the rate limit.
const RETRY_BACKOFF_MS = 3000;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mbFetch(pathname: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${MB_BASE}${pathname}`);
  url.searchParams.set("fmt", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    // Node fetch has NO default timeout — a hung socket froze a whole
    // enrichment run for 30+ minutes mid-artist on a real run. Abort and
    // treat it like any transient failure (one retry, then throw).
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
      throw new Error(`MusicBrainz ${pathname} -> ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return res.json();
    if (attempt === 0 && isTransientStatus(res.status)) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`MusicBrainz ${pathname} -> HTTP ${res.status}`);
  }
}

// --- Pure helpers (exported for musicbrainz.test.ts — no network) ---

/** Lucene-escape a value that will be interpolated inside a "..." phrase. */
export function escapeLucene(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
 * neither — that's an accepted gap (see SPEC-MUSIC.md Facts).
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
// to the same space character — so folder-sanitised titles like
// "The Singles 86_98" and MusicBrainz's "The Singles 86/98" normalize
// identically for free.
const TAG_RE = /[[(][^\])]*[\])]/g;

export function normalizeAlbumTitle(title: string): string {
  return normalizeTitle(title.replace(TAG_RE, " "));
}

/**
 * Classify a release-group's kind from its primary/secondary types, per
 * SPEC-MUSIC.md's Enrichment section. The release-group search query already
 * filters to primarytype:(album OR ep), so "single" should never reach here;
 * the OTHER fallback covers it defensively regardless (Album rows are never
 * created for kind !== STUDIO, so a stray single can't leak into the DB).
 */
export function classifyAlbumKind(
  primaryType: string | null | undefined,
  secondaryTypes: string[] | null | undefined,
): AlbumKind {
  const secondary = (secondaryTypes ?? []).map((s) => s.toLowerCase());
  const primary = (primaryType ?? "").toLowerCase();

  if (secondary.includes("compilation")) return "COMPILATION";
  if (secondary.includes("live")) return "LIVE";
  if (secondary.includes("remix")) return "REMIX";
  if (secondary.includes("soundtrack")) return "SOUNDTRACK";
  if (primary === "ep") return "EP";
  if (primary === "album") return "STUDIO";
  return "OTHER";
}

export interface ParsedReleaseDate {
  year: number | null;
  releaseDate: Date | null;
}

/** Parse MusicBrainz's "first-release-date", which may be "YYYY", "YYYY-MM", or "YYYY-MM-DD". */
export function parseReleaseDate(dateStr: string | null | undefined): ParsedReleaseDate {
  if (!dateStr) return { year: null, releaseDate: null };
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(dateStr);
  if (!m) return { year: null, releaseDate: null };
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) - 1 : 0;
  const day = m[3] ? Number(m[3]) : 1;
  return { year, releaseDate: new Date(Date.UTC(year, month, day)) };
}

export interface ParsedReleaseTrack {
  disc: number;
  trackNumber: number | null;
  title: string;
  durationSecs: number | null;
}

/**
 * Flatten a MusicBrainz release's "media" (inc=recordings+media) into a
 * disc-ordered tracklist. A track's own title can differ from its
 * recording's canonical title (a pressing-specific edit/remaster credit) —
 * prefer the track title, falling back to the recording's.
 */
export function parseReleaseMedia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  media: any[] | null | undefined,
): ParsedReleaseTrack[] {
  const out: ParsedReleaseTrack[] = [];
  for (const medium of media ?? []) {
    const disc = Number(medium.position) || 1;
    for (const t of medium.tracks ?? []) {
      const trackNumber = Number.isFinite(Number(t.number)) ? Number(t.number) : (t.position ?? null);
      out.push({
        disc,
        trackNumber,
        title: t.title || t.recording?.title || "Untitled",
        durationSecs: typeof t.length === "number" ? t.length / 1000 : null,
      });
    }
  }
  return out;
}

/** Fetch one release's full tracklist, disc-ordered. */
async function fetchReleaseTrackList(releaseMbid: string): Promise<ParsedReleaseTrack[]> {
  const release = await mbFetch(`/release/${releaseMbid}`, { inc: "recordings+media" });
  return parseReleaseMedia(release.media);
}

// --- Artist matching ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchArtist(name: string): Promise<any[]> {
  const data = await mbFetch("/artist", { query: `artist:"${escapeLucene(name)}"` });
  return (data.artists ?? []).slice(0, 10);
}

interface ArtistMatch {
  mbid: string;
  name: string;
  disambiguation: string | null;
  confidence: "EXACT" | "SEARCH" | "LOW";
}

/**
 * Mimics pickHit() in tmdb.ts: prefer an exact normalized-name match among
 * the top results; otherwise fall back to MusicBrainz's own top-scored hit
 * when it's confident enough. Tried against the folder name as-is first,
 * then (if nothing usable) the reversed-sanitisation variant — an exact
 * match on the fallback variant is still SEARCH-grade (we had to guess at
 * the real name), a fuzzy match on it is LOW.
 */
async function matchArtist(folderDerivedName: string): Promise<ArtistMatch | null> {
  const variants = artistNameVariants(folderDerivedName);
  const want = normalizeArtistName(folderDerivedName);

  for (let i = 0; i < variants.length; i++) {
    const isPrimary = i === 0;
    const results = await searchArtist(variants[i]);
    if (!results.length) continue;

    const exact = results.find((r) => normalizeArtistName(r.name ?? "") === want);
    if (exact) {
      return {
        mbid: exact.id,
        name: exact.name,
        disambiguation: exact.disambiguation || null,
        confidence: isPrimary ? "EXACT" : "SEARCH",
      };
    }

    const top = results[0];
    const score = Number(top.score ?? 0);
    if (score >= 90) {
      return {
        mbid: top.id,
        name: top.name,
        disambiguation: top.disambiguation || null,
        confidence: isPrimary ? "SEARCH" : "LOW",
      };
    }
  }
  return null;
}

// --- Release-group listing ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchReleaseGroups(artistMbid: string): Promise<any[]> {
  // status:official + primarytype:(album OR ep) via the *search* endpoint —
  // browse would include bootlegs. Never matches primarytype:single, so no
  // Album row is ever created for a single release.
  const query = `arid:${artistMbid} AND status:official AND (primarytype:album OR primarytype:ep)`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];
  let offset = 0;
  for (;;) {
    const data = await mbFetch("/release-group", { query, limit: String(RG_PAGE_LIMIT), offset: String(offset) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch: any[] = data["release-groups"] ?? [];
    results.push(...batch);
    offset += batch.length;
    const total: number = data.count ?? batch.length;
    if (batch.length === 0 || offset >= total) break;
  }
  return results;
}

// --- Barcode lookup (scan-to-collection) ---

export interface BarcodeReleaseMatch {
  releaseGroupMbid: string;
  /** The specific release (pressing) the barcode matched — distinct from
   *  releaseGroupMbid. Carries this pressing's own tracklist/cover, which
   *  can differ from other pressings of the same release-group (a vinyl
   *  reissue with a different running order/art than the CD). */
  releaseMbid: string;
  title: string;
  artistName: string;
  year: number | null;
  /** MusicBrainz release media format, e.g. "CD", "12\" Vinyl" — used to
   *  pre-fill the medium picker on the scan page. */
  format: string | null;
  /** Cover Art Archive URL for the release-group — constructed, not
   *  verified (CAA 404s when no art exists; the client falls back to a
   *  placeholder on image load error rather than us HEAD-checking here). */
  coverArtUrl: string;
}

/**
 * Resolve a barcode to a release via MusicBrainz's own barcode index (free,
 * no key, exact match only — no fuzzy fallback needed since a barcode is
 * either present verbatim or it isn't). Picks the first result with a
 * resolvable release-group; MusicBrainz already ranks exact barcode matches
 * first.
 */
export async function searchReleaseByBarcode(barcode: string): Promise<BarcodeReleaseMatch | null> {
  const data = await mbFetch("/release", {
    query: `barcode:${barcode}`,
    inc: "release-groups+artist-credits+media",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const releases: any[] = data.releases ?? [];
  const hit = releases.find((r) => r["release-group"]?.id);
  if (!hit) return null;

  const artistName = hit["artist-credit"]?.[0]?.artist?.name ?? hit["artist-credit"]?.[0]?.name ?? "Unknown Artist";
  const year = hit.date ? Number(hit.date.slice(0, 4)) : null;
  const format: string | null = hit.media?.[0]?.format ?? null;

  return {
    releaseGroupMbid: hit["release-group"].id,
    releaseMbid: hit.id,
    title: hit["release-group"].title ?? hit.title,
    artistName,
    year: Number.isFinite(year) ? year : null,
    format,
    coverArtUrl: `https://coverartarchive.org/release-group/${hit["release-group"].id}/front-250`,
  };
}

export interface TitleSearchAlbum {
  mbid: string;
  title: string;
  artistName: string;
  year: number | null;
  coverArtUrl: string;
}

// A short stoplist for titleOverlap below — dropped from both sides before
// comparing so a shared "the"/"of" doesn't inflate an otherwise-unrelated
// match (see the Wombles case in titleOverlap's own comment).
const TITLE_STOPWORDS = new Set(["the", "a", "an", "of", "and", "in", "on"]);

function titleWords(title: string): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length > 0 && !TITLE_STOPWORDS.has(w));
}

/**
 * Fraction of the shorter title's (stopword-stripped) words that also
 * appear in the other title — same-or-prefix, length >= 4, so cross-catalog
 * inflection/translation drift still counts as a match (Discogs "Renaissance
 * Of The Celtic Harp" vs MusicBrainz's French "Renaissance de la harpe
 * celtique": harp/harpe and celtic/celtique both prefix-match) without
 * pulling in a real stemming library. Used only by searchReleaseGroupAnchor
 * below, to reject a same-artist result that shares nothing with the
 * searched title (e.g. "Sing Hits Of The Wombles" search that MusicBrainz
 * has no entry for at all still hands back *some* top hit by that artist —
 * "The Paris & Italian Suites" — which must not be silently accepted as the
 * anchor just because the artist matched).
 */
function titleOverlap(a: string, b: string): number {
  const wordsA = titleWords(a);
  const wordsB = titleWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const [smaller, larger] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];

  let shared = 0;
  for (const w of smaller) {
    if (larger.some((x) => w === x || (w.length >= 4 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x)))) {
      shared++;
    }
  }
  return shared / smaller.length;
}

const ANCHOR_OVERLAP_THRESHOLD = 0.5;

/**
 * Anchor search for a Discogs-only release — the barcode->Discogs fallback
 * and the Scan page's "paste Discogs links" tool (see scan-resolve.ts's
 * pickAnchor, which this feeds). Unlike searchReleaseGroupsByTitle's
 * exact-phrase match (fine there — a human picks from the results), this
 * anchor gets used with nobody checking it, so it trades exactness for
 * recall: title terms go in unquoted (MusicBrainz's own title for the same
 * record often differs from Discogs' — spelled-out numbers, a dropped
 * subtitle, a translated title for a non-English release — see this
 * function's test cases in the "paste Discogs links" work), and the
 * artist stays an exact quoted match, same as before. The recall trade is
 * only safe because of the titleOverlap check below: without it, a search
 * that matches on artist alone but has no real title hit would still hand
 * back that artist's top-ranked release and get silently, wrongly, anchored
 * to it.
 */
export async function searchReleaseGroupAnchor(title: string, artist: string): Promise<TitleSearchAlbum[]> {
  const query = `releasegroup:(${normalizeTitle(title)}) AND artist:"${escapeLucene(artist)}"`;
  const data = await mbFetch("/release-group", { query, limit: "5" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups: any[] = data["release-groups"] ?? [];

  return groups
    .map((rg) => {
      const year = rg["first-release-date"] ? Number(rg["first-release-date"].slice(0, 4)) : null;
      return {
        mbid: rg.id,
        title: rg.title,
        artistName: rg["artist-credit"]?.[0]?.artist?.name ?? rg["artist-credit"]?.[0]?.name ?? "Unknown Artist",
        year: Number.isFinite(year) ? year : null,
        coverArtUrl: `https://coverartarchive.org/release-group/${rg.id}/front-250`,
      };
    })
    .filter((rg) => titleOverlap(title, rg.title) >= ANCHOR_OVERLAP_THRESHOLD);
}

/**
 * Free-text release-group search for the scan page's "Search by title"
 * fallback — no barcode involved, so this is MusicBrainz's own relevance
 * ranking rather than an exact match. Scoped to album/EP primary types, same
 * as searchReleaseGroups's back-catalogue listing, so a bare single never
 * shows up as an addable candidate.
 */
export async function searchReleaseGroupsByTitle(title: string, artist?: string): Promise<TitleSearchAlbum[]> {
  let query = `releasegroup:"${escapeLucene(title)}" AND (primarytype:album OR primarytype:ep)`;
  if (artist) query += ` AND artist:"${escapeLucene(artist)}"`;

  const data = await mbFetch("/release-group", { query, limit: "5" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups: any[] = data["release-groups"] ?? [];

  return groups.map((rg) => {
    const year = rg["first-release-date"] ? Number(rg["first-release-date"].slice(0, 4)) : null;
    return {
      mbid: rg.id,
      title: rg.title,
      artistName: rg["artist-credit"]?.[0]?.artist?.name ?? rg["artist-credit"]?.[0]?.name ?? "Unknown Artist",
      year: Number.isFinite(year) ? year : null,
      coverArtUrl: `https://coverartarchive.org/release-group/${rg.id}/front-250`,
    };
  });
}

// --- Cover art pass (shared by matched and various=true artists) ---

async function fetchMissingCoversForArtist(artistId: number, artistName: string, log: string[]): Promise<void> {
  // coverSource "manual" is an owner-curated override — never revisited here
  // even if coverPath were somehow null (fetchCover also refuses outright,
  // this just avoids the wasted attempt).
  // No coverSource filter here: a "manual" cover always has coverPath set, so
  // coverPath:null already excludes it (and fetchCover refuses manual rows
  // defensively). An explicit NOT-equals would be a NULL-semantics trap —
  // SQL `NOT (coverSource = 'manual')` silently drops the NULL rows, which is
  // every un-fetched album, turning the whole cover pass into a no-op.
  const needCovers = await prisma.album.findMany({
    where: { artistId, coverPath: null },
  });
  for (const album of needCovers) {
    try {
      const result = await fetchCover({
        id: album.id,
        mbid: album.mbid,
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
      // Cover art is best-effort — a failure here must never abort enrichment.
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Cover art fetch failed for "${album.title}" (${artistName}): ${message}`);
    }
  }
}

// --- Album reconciliation ---

// When two release groups share a normalized title (real case: Linkin Park's
// "Hybrid Theory" studio album vs the band's 1999 "Hybrid Theory" EP), the
// owned album must be claimed by the best-ranked kind, not whichever the
// search happened to return first.
const KIND_CLAIM_ORDER: AlbumKind[] = ["STUDIO", "EP", "LIVE", "COMPILATION", "REMIX", "SOUNDTRACK", "OTHER"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rgKindRank(rg: any): number {
  const idx = KIND_CLAIM_ORDER.indexOf(classifyAlbumKind(rg["primary-type"], rg["secondary-types"]));
  return idx === -1 ? KIND_CLAIM_ORDER.length : idx;
}

async function reconcileArtistAlbums(artistId: number, artistName: string, artistMbid: string, log: string[]): Promise<void> {
  const releaseGroups = (await searchReleaseGroups(artistMbid)).sort((a, b) => rgKindRank(a) - rgKindRank(b));
  const rgById = new Map(releaseGroups.map((rg) => [rg.id as string, rg]));
  const ownedAlbums = await prisma.album.findMany({ where: { artistId, owned: true } });

  const claimedRgIds = new Set<string>();
  const claimedOwnedIds = new Set<number>();

  // Pre-pass — ordinal disambiguation for identically-titled release groups.
  // Some artists have several albums with the SAME title (Peter Gabriel's
  // first four are all "Peter Gabriel"); the owner's folders disambiguate
  // with a numeric tag — "Peter Gabriel (3)" — which normalizeAlbumTitle
  // strips, making the bare title-match pairing arbitrary. When an owned
  // album carries a trailing "(N)"/"[N]" and 2+ release groups share its
  // normalized title, treat N as a 1-based index into that group's
  // best-kind subset, date-sorted and deduped to ONE entry per release year
  // (MusicBrainz holds more same-titled groups than the canonical run —
  // e.g. the German-language 1980 album — and without the year dedupe the
  // index drifts): (1)=1977 Car, (3)=1980 Melt, (4)=1982 Security.
  //
  // Assignments are computed for the whole artist first and applied in two
  // phases (null every batch member's mbid, then set the new ones) because
  // members can swap release groups with each other — updating in place
  // trips the mbid unique constraint mid-swap, which on a real run aborted
  // the whole artist ("Peter Gabriel (4)" had just claimed the group that
  // "(3)" was being moved to).
  const rgsByNormTitle = new Map<string, typeof releaseGroups>();
  for (const rg of releaseGroups) {
    const t = normalizeAlbumTitle(rg.title ?? "");
    const arr = rgsByNormTitle.get(t);
    if (arr) arr.push(rg);
    else rgsByNormTitle.set(t, [rg]);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ordinalBatch: { album: (typeof ownedAlbums)[number]; rg: any }[] = [];
  const batchTargetIds = new Set<string>();
  for (const a of ownedAlbums) {
    const ordMatch = /[([](\d{1,2})[)\]]\s*$/.exec(a.title);
    if (!ordMatch) continue;
    const ordinal = Number(ordMatch[1]);
    const group = rgsByNormTitle.get(normalizeAlbumTitle(a.title));
    if (!group || group.length < 2) continue;
    const bestRank = Math.min(...group.map(rgKindRank));
    const seenYears = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: any[] = [];
    for (const rg of group
      .filter((rg) => rgKindRank(rg) === bestRank)
      .slice()
      .sort((x, y) => (x["first-release-date"] ?? "9999").localeCompare(y["first-release-date"] ?? "9999"))) {
      const yr = (rg["first-release-date"] ?? "").slice(0, 4) || "?";
      if (seenYears.has(yr)) continue;
      seenYears.add(yr);
      candidates.push(rg);
    }
    const rg = candidates[ordinal - 1];
    if (!rg || batchTargetIds.has(rg.id)) continue;
    ordinalBatch.push({ album: a, rg });
    batchTargetIds.add(rg.id);
  }
  if (ordinalBatch.length > 0) {
    const batchAlbumIds = new Set(ordinalBatch.map((b) => b.album.id));
    // Phase 0: resolve outside holders of our target groups — reclaim
    // placeholders, and skip any member whose target is held by an owned
    // album that isn't itself being reassigned (left for review).
    const applicable: typeof ordinalBatch = [];
    for (const b of ordinalBatch) {
      const holder = await prisma.album.findUnique({ where: { mbid: b.rg.id } });
      if (holder && holder.id !== b.album.id && !batchAlbumIds.has(holder.id)) {
        if (!holder.owned) {
          await prisma.album.delete({ where: { id: holder.id } });
        } else {
          log.push(
            `Ordinal match for "${b.album.title}" (${artistName}) skipped — release-group ${b.rg.id} is held by owned "${holder.title}"`,
          );
          continue;
        }
      }
      applicable.push(b);
    }
    // Phase 1: free the unique constraint across the whole batch.
    for (const b of applicable) {
      if (b.album.mbid && b.album.mbid !== b.rg.id) {
        await prisma.album.update({ where: { id: b.album.id }, data: { mbid: null } });
      }
    }
    // Phase 2: apply the assignments.
    for (const b of applicable) {
      const kind = classifyAlbumKind(b.rg["primary-type"], b.rg["secondary-types"]);
      const { year, releaseDate } = parseReleaseDate(b.rg["first-release-date"]);
      const invalidateCover =
        b.album.mbid != null &&
        b.album.mbid !== b.rg.id &&
        b.album.coverSource !== "embedded" &&
        b.album.coverSource !== "manual";
      await prisma.album.update({
        where: { id: b.album.id },
        data: { mbid: b.rg.id, year, releaseDate, kind, ...(invalidateCover ? { coverPath: null, coverSource: null } : {}) },
      });
      claimedRgIds.add(b.rg.id);
      claimedOwnedIds.add(b.album.id);
      b.album.mbid = b.rg.id;
      b.album.kind = kind;
      log.push(
        `Ordinal-matched "${b.album.title}" (${artistName}) to release-group ${b.rg.id} (${b.rg["first-release-date"] ?? "?"})`,
      );
    }
  }

  // Pass 1: attach mbid/year/releaseDate/kind to owned albums, matched either
  // by an mbid already recorded from a prior run (idempotent) or by
  // normalized title (extends normalizeTitle-style matching, see
  // normalizeAlbumTitle above).
  for (const rg of releaseGroups) {
    // A group claimed by the ordinal pre-pass (or earlier in this loop) is
    // settled — without this guard the worse-kind re-claim below could try
    // to move a second album onto it and trip the mbid unique constraint.
    if (claimedRgIds.has(rg.id)) continue;
    const kind = classifyAlbumKind(rg["primary-type"], rg["secondary-types"]);
    const { year, releaseDate } = parseReleaseDate(rg["first-release-date"]);
    const wantTitle = normalizeAlbumTitle(rg.title ?? "");

    const titleMatches = (a: { title: string }) =>
      normalizeAlbumTitle(a.title) === wantTitle || normalizeAlbumTitle(`${artistName} ${a.title}`) === wantTitle;

    let reclaimedFromWorseKind = false;
    let owned = ownedAlbums.find((a) => !claimedOwnedIds.has(a.id) && a.mbid === rg.id);
    if (!owned) {
      // Also try the folder title prefixed with the artist name: release
      // groups are often titled "<Artist>: <Album>" where the folder is just
      // "<Album>" (real case: Blur's "The Best Of" folder vs MusicBrainz's
      // "Blur: The Best Of" — normalizeTitle folds the ":" so the prefixed
      // variant matches exactly).
      owned = ownedAlbums.find((a) => !claimedOwnedIds.has(a.id) && !a.mbid && titleMatches(a));
    }
    if (!owned) {
      // Self-heal a prior wrong claim: this rg's title matches an album that
      // is currently attached to a WORSE-ranked release group with the same
      // ambiguous title (the Hybrid Theory studio/EP case). Re-claim it here
      // — release groups iterate best-kind-first, so this rg wins.
      owned = ownedAlbums.find((a) => {
        if (claimedOwnedIds.has(a.id) || !a.mbid || a.mbid === rg.id) return false;
        const prevRg = rgById.get(a.mbid);
        if (!prevRg || rgKindRank(prevRg) <= rgKindRank(rg)) return false;
        return titleMatches(a);
      });
      if (owned) {
        reclaimedFromWorseKind = true;
        log.push(
          `Re-claimed "${owned.title}" (${artistName}) from ${classifyAlbumKind(rgById.get(owned.mbid!)?.["primary-type"], rgById.get(owned.mbid!)?.["secondary-types"])} release-group ${owned.mbid} to ${kind} ${rg.id}`,
        );
      }
    }
    if (!owned) continue;

    claimedRgIds.add(rg.id);
    claimedOwnedIds.add(owned.id);

    if (owned.mbid !== rg.id) {
      // Another row may already hold this release-group id: a missing-album
      // placeholder from a prior run (reclaim it — the album on disk takes
      // its place) or a genuine second owned album (never merge on a title
      // match alone — flag it and leave both untouched, mirroring tmdb.ts's
      // caution around search-based collisions). This must run for re-claims
      // too, not just first-time matches: Pulp's "This Is Hardcore" moving
      // off the EP group repeatedly hit the unique constraint because the
      // studio group's own placeholder row was never reclaimed first.
      const holder = await prisma.album.findUnique({ where: { mbid: rg.id } });
      if (holder && holder.id !== owned.id) {
        if (!holder.owned) {
          await prisma.album.delete({ where: { id: holder.id } });
          log.push(`Reclaimed missing-album placeholder "${holder.title}" for "${artistName}" — "${owned.title}" is on disk`);
        } else {
          log.push(
            `Match conflict: "${owned.title}" and "${holder.title}" (${artistName}) both normalize to MusicBrainz release-group ${rg.id} — left unmatched for review`,
          );
          continue;
        }
      }
    }

    // A re-claim means the previously fetched cover belongs to the WRONG
    // release group — invalidate it so the cover pass re-fetches, unless it
    // came from the file's own embedded art or a manual pick (both are
    // correct regardless of which release group we matched).
    const invalidateCover =
      reclaimedFromWorseKind && owned.coverSource !== "embedded" && owned.coverSource !== "manual";
    await prisma.album.update({
      where: { id: owned.id },
      data: {
        mbid: rg.id,
        year,
        releaseDate,
        kind,
        ...(invalidateCover ? { coverPath: null, coverSource: null } : {}),
      },
    });
    // Keep the in-memory row consistent so a worse-ranked release group later
    // in this loop can't find the stale mbid and claim the album back.
    owned.mbid = rg.id;
    owned.kind = kind;
  }

  // Owned albums that matched no release group at all keep the scanner's
  // default kind STUDIO, which pollutes the studio timeline (real case: Kebu's
  // "Live Online" and "Live in Oslo - DVD" are absent from MusicBrainz and
  // showed as undated studio albums). A "live" in the title is a strong
  // enough signal to reclassify just those leftovers; everything else stays
  // STUDIO, and a later successful match overwrites the heuristic anyway.
  for (const a of ownedAlbums) {
    if (claimedOwnedIds.has(a.id) || a.mbid || a.kind !== "STUDIO") continue;
    if (/\blive\b/i.test(a.title)) {
      await prisma.album.update({ where: { id: a.id }, data: { kind: "LIVE" } });
      log.push(`Reclassified unmatched "${a.title}" (${artistName}) as LIVE by title heuristic`);
    } else if (/\b(best of|greatest hits|golden greats|the hits|singles|collection|anthology)\b/i.test(a.title)) {
      await prisma.album.update({ where: { id: a.id }, data: { kind: "COMPILATION" } });
      log.push(`Reclassified unmatched "${a.title}" (${artistName}) as COMPILATION by title heuristic`);
    }
  }

  // studioTotal is recorded regardless of whether gap tracking qualifies below
  // — it's what lets the UI show an honest "1/282 owned" instead of "1/1".
  const studioReleaseGroups = releaseGroups.filter(
    (rg) => classifyAlbumKind(rg["primary-type"], rg["secondary-types"]) === "STUDIO",
  );
  const studioTotal = studioReleaseGroups.length;
  await prisma.artist.update({ where: { id: artistId }, data: { studioTotal } });

  // Gap-tracking gate (see SPEC-MUSIC.md / constants.ts MUSIC_GAP_MIN_OWNED,
  // MUSIC_GAP_MIN_PCT): only create/maintain owned=false placeholders once we
  // own enough of the artist to be worth completing. Without this, a single
  // owned disc by a prolific or classical artist (Barenboim: 1 of 282 studio
  // release groups) spawns hundreds of missing-album placeholders and the
  // cover pass then fetches art for every one of them.
  const ownedStudioCount = await prisma.album.count({ where: { artistId, owned: true, kind: "STUDIO" } });
  const qualifies =
    studioTotal > 0 && ownedStudioCount >= MUSIC_GAP_MIN_OWNED && ownedStudioCount / studioTotal >= MUSIC_GAP_MIN_PCT;

  if (!qualifies) {
    // Not (yet) worth tracking the gap: no placeholders are created, and any
    // placeholders created by a prior run (before this gate existed, or from
    // when the artist briefly qualified) are cleaned up. Owned-album
    // backfill above and owned-album cover fetch below still happen.
    // physicalCopies none excludes physical-only albums — those are
    // owned=false (no digital rip) by construction but represent an LP/CD
    // you actually have, not a gap-tracking guess, so gap tracking must
    // never sweep them up regardless of whether the artist qualifies.
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

  // Pass 2: create owned=false placeholders for STUDIO groups we don't own.
  for (const rg of releaseGroups) {
    if (claimedRgIds.has(rg.id)) continue;
    const kind = classifyAlbumKind(rg["primary-type"], rg["secondary-types"]);
    if (kind !== "STUDIO") continue;

    const { year, releaseDate } = parseReleaseDate(rg["first-release-date"]);
    const existing = await prisma.album.findUnique({ where: { mbid: rg.id } });
    if (existing) {
      if (existing.owned) continue; // reconciled in pass 1 by another path — leave alone
      await prisma.album.update({
        where: { id: existing.id },
        data: { title: rg.title, sortTitle: sortTitle(rg.title), year, releaseDate, kind: "STUDIO" },
      });
    } else {
      await prisma.album.create({
        data: {
          artistId,
          title: rg.title,
          sortTitle: sortTitle(rg.title),
          year,
          releaseDate,
          mbid: rg.id,
          kind: "STUDIO",
          owned: false,
          folder: null,
        },
      });
      log.push(`Added missing studio album "${rg.title}"${year ? ` (${year})` : ""} for "${artistName}"`);
    }
  }

  // Pass 3: delete owned=false placeholders whose release group vanished
  // from this run's STUDIO listing (deleted upstream, or reclassified away
  // from album/ep/studio). physicalCopies none excludes physical-only
  // albums — e.g. a vinyl-only live album or compilation would never appear
  // in seenStudioMbids (which is STUDIO-only) and would otherwise get
  // deleted on the very next enrich run despite being a real, owned copy.
  const seenStudioMbids = new Set(
    releaseGroups
      .filter((rg) => classifyAlbumKind(rg["primary-type"], rg["secondary-types"]) === "STUDIO")
      .map((rg) => rg.id as string),
  );
  const stalePlaceholders = await prisma.album.findMany({
    where: { artistId, owned: false, mbid: { not: null }, physicalCopies: { none: {} } },
  });
  for (const stale of stalePlaceholders) {
    if (stale.mbid && !seenStudioMbids.has(stale.mbid)) {
      await prisma.album.delete({ where: { id: stale.id } });
      log.push(`Removed vanished back-catalogue placeholder "${stale.title}" for "${artistName}"`);
    }
  }

  await fetchMissingCoversForArtist(artistId, artistName, log);
}

// --- Per-artist driver ---

/**
 * Roon-style bio/photo/backdrop, best-effort — see fetchArtistEnrichment.
 * Only fetches pieces this artist doesn't already have (never re-fetches, and
 * never touches a "manual" owner-curated field), and never blocks or fails
 * the wider enrich run over a lookup miss.
 */
async function enrichArtistBioAndImages(
  artistId: number,
  artistName: string,
  mbid: string | null,
  log: string[],
): Promise<void> {
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
    const result = await fetchArtistEnrichment({ id: artistId, mbid, name: artistName, needsBio, needsPhoto, needsBackdrop });
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
  let mbid = artist.mbid;

  if (!mbid || artist.matchConfidence === "UNMATCHED" || artist.matchConfidence === "LOW") {
    const match = await matchArtist(artist.name);
    if (match) {
      const holder = await prisma.artist.findUnique({ where: { mbid: match.mbid } });
      if (holder && holder.id !== artist.id) {
        log.push(
          `Match conflict: "${artist.name}" matched MusicBrainz artist "${match.name}" (mb:${match.mbid}), already claimed by "${holder.name}" — left unmatched for review`,
        );
      } else {
        await prisma.artist.update({
          where: { id: artist.id },
          data: { mbid: match.mbid, disambiguation: match.disambiguation, matchConfidence: match.confidence },
        });
        mbid = match.mbid;
        if (match.confidence === "LOW") {
          log.push(`Low-confidence match: "${artist.name}" -> "${match.name}" (mb:${match.mbid})`);
        }
      }
    } else if (!mbid) {
      log.push(`No MusicBrainz match for artist "${artist.name}"`);
    }
  }

  if (!mbid) {
    // Stays UNMATCHED — no release-group listing to reconcile against. The
    // cover pass still runs: embedded art needs no MusicBrainz id at all,
    // and a manually-matched album (POST /api/album-match) has its own
    // release-group mbid for CAA despite the artist being unmatched. Bio
    // enrichment still runs too — Wikipedia's name-based lookup needs no
    // mbid at all, unlike TheAudioDB/Fanart.tv.
    await fetchMissingCoversForArtist(artist.id, artist.name, log);
    await enrichArtistBioAndImages(artist.id, artist.name, null, log);
    return;
  }

  await reconcileArtistAlbums(artist.id, artist.name, mbid, log);
  await enrichArtistBioAndImages(artist.id, artist.name, mbid, log);
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
        // Compilations pseudo-artist: skip MB artist matching and the
        // back-catalogue listing entirely (see SPEC-MUSIC.md Facts), but
        // still fetch covers for its owned albums so the artist grid tile
        // isn't blank.
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
 * Kick off MusicBrainz enrichment. Resolves quickly once the run is
 * registered (or an existing run is found) — the actual work continues in
 * the background and is not awaited here. No API key is required (unlike
 * TMDB) since MusicBrainz's search API is open, gated only by rate limit.
 */
export async function runMusicEnrich(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("ENRICH_MUSIC");
  if (!started) return { runId: run.id, started: false };

  doMusicEnrich(run.id).catch(async (err) => {
    console.error("[musicbrainz] enrich failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[musicbrainz] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}

// --- Manual matching (POST /api/album-match) ---

// Domain-agnostic on purpose: a local musicbrainz-docker mirror (see
// MUSICBRAINZ_BASE_URL) serves the same browsable pages at its own host —
// e.g. http://localhost:15000/release/<uuid> — and pasting that URL should
// work exactly like a musicbrainz.org one. The domain was never doing real
// validation anyway; the actual check is the MusicBrainz API lookup that
// follows a match.
const MB_URL_RE = /\/(release|release-group)\/([0-9a-f-]{36})/i;
const MB_UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Accepts a musicbrainz.org release or release-group URL (or a bare UUID,
 * treated as a release-group id) and resolves it to a release-group. iTunes
 * rips from before MusicBrainz-accurate tagging often can't be auto-matched
 * — this is the owner's escape hatch.
 */
export async function applyManualAlbumMatch(
  albumId: number,
  mb: string,
): Promise<{ ok: true; album: { id: number; title: string; kind: string; year: number | null; mbid: string } } | { ok: false; status: number; error: string }> {
  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) return { ok: false, status: 404, error: "unknown album id" };
  if (!album.owned) return { ok: false, status: 400, error: "cannot manually match a missing-album placeholder" };

  const urlMatch = MB_URL_RE.exec(mb);
  let entity: "release" | "release-group";
  let mbId: string;
  if (urlMatch) {
    entity = urlMatch[1].toLowerCase() as "release" | "release-group";
    mbId = urlMatch[2].toLowerCase();
  } else if (MB_UUID_RE.test(mb.trim())) {
    entity = "release-group";
    mbId = mb.trim().toLowerCase();
  } else {
    return { ok: false, status: 400, error: "expected a musicbrainz.org release/release-group URL or a release-group UUID" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rg: any;
  try {
    if (entity === "release") {
      const release = await mbFetch(`/release/${mbId}`, { inc: "release-groups" });
      rg = release["release-group"];
      if (!rg?.id) return { ok: false, status: 502, error: "release has no release-group" };
      // The release payload's embedded group omits first-release-date in some
      // responses — fetch the group itself for authoritative fields.
      rg = await mbFetch(`/release-group/${rg.id}`, {});
    } else {
      rg = await mbFetch(`/release-group/${mbId}`, {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `MusicBrainz lookup failed: ${message}` };
  }

  const holder = await prisma.album.findUnique({ where: { mbid: rg.id } });
  if (holder && holder.id !== album.id) {
    if (!holder.owned) {
      await prisma.album.delete({ where: { id: holder.id } });
    } else {
      return { ok: false, status: 409, error: `release-group already matched to owned album "${holder.title}"` };
    }
  }

  const kind = classifyAlbumKind(rg["primary-type"], rg["secondary-types"]);
  const { year, releaseDate } = parseReleaseDate(rg["first-release-date"]);
  // Identity changed: a previously fetched online cover may belong to the
  // old (wrong) match. Embedded/manual covers are correct regardless.
  const invalidateCover =
    album.mbid !== rg.id && album.coverPath != null && album.coverSource !== "embedded" && album.coverSource !== "manual";
  const updated = await prisma.album.update({
    where: { id: album.id },
    data: {
      mbid: rg.id,
      kind,
      year: year ?? album.year,
      releaseDate: releaseDate ?? album.releaseDate,
      ...(invalidateCover ? { coverPath: null, coverSource: null } : {}),
    },
  });

  return { ok: true, album: { id: updated.id, title: updated.title, kind: updated.kind, year: updated.year, mbid: rg.id } };
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

/**
 * Populate one PhysicalCopy's pressing-specific tracklist and cover art from
 * a known release id — best-effort throughout (mirrors fetchCover's
 * never-throws contract): a failed track/cover fetch just leaves the copy
 * without them, it never fails the caller's larger operation (adding the
 * copy, matching a release). Replaces any existing PhysicalTrack rows
 * outright rather than diffing, since a re-attach means the owner is
 * correcting which pressing this copy actually is.
 */
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

async function populatePhysicalReleaseFromMusicBrainz(
  copy: { id: number; albumId: number; medium: string; coverSource: string | null },
  releaseMbid: string,
): Promise<void> {
  try {
    await replacePhysicalTracks(copy.id, await fetchReleaseTrackList(releaseMbid));
  } catch {
    // best-effort — a fetch failure just means "no tracks", not partial data
  }
  try {
    await saveCoverIfFound(
      copy.id,
      await fetchPhysicalCopyCover({
        albumId: copy.albumId,
        medium: copy.medium,
        releaseMbid,
        coverSource: copy.coverSource,
      }),
    );
  } catch {
    // best-effort — no cover for this pressing, the album's own still shows
  }
}

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
    // add whose MusicBrainz release-group has no Cover Art Archive entry and
    // no iTunes match either (fetchCover in cover-art.ts) would otherwise
    // stay coverless even though a perfectly usable photo was just fetched
    // for the pressing above.
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
 * ripped or not) to a specific MusicBrainz release — pulling in that
 * pressing's own tracklist and cover art, which can differ from the
 * release-group's (a vinyl reissue with a different running order/art than
 * the CD it shares an Album row with). Unlike createPhysicalOnlyAlbum and
 * applyManualAlbumMatch, a bare UUID here is a *release* id, not a
 * release-group id — this function only exists to attach release-level
 * data, so accepting a release-group id would be a silent no-op.
 */
/**
 * Dispatches on the input's shape — a Discogs release URL/bare id, a
 * MusicBrainz release URL, or a bare MusicBrainz release UUID — to whichever
 * source actually has this pressing. Falls back to Discogs when MusicBrainz
 * simply has no entry for it (common for smaller-run/newer vinyl).
 */
export async function attachPhysicalRelease(
  albumId: number,
  medium: PhysicalMedium,
  mb: string,
): Promise<{ ok: true; trackCount: number } | { ok: false; status: number; error: string }> {
  const trimmed = mb.trim();

  const discogsUrlMatch = DISCOGS_URL_RE.exec(trimmed);
  const mbUrlMatch = MB_URL_RE.exec(trimmed);

  let source: "musicbrainz" | "discogs";
  let releaseMbid: string | null = null;
  let discogsReleaseId: number | null = null;

  if (discogsUrlMatch) {
    source = "discogs";
    discogsReleaseId = Number(discogsUrlMatch[1]);
  } else if (mbUrlMatch) {
    if (mbUrlMatch[1].toLowerCase() !== "release") {
      return {
        ok: false,
        status: 400,
        error: "expected a specific release URL (musicbrainz.org/release/...), not a release-group — a release-group has no fixed tracklist or cover",
      };
    }
    source = "musicbrainz";
    releaseMbid = mbUrlMatch[2].toLowerCase();
  } else if (MB_UUID_RE.test(trimmed)) {
    source = "musicbrainz";
    releaseMbid = trimmed.toLowerCase();
  } else if (/^\d+$/.test(trimmed)) {
    source = "discogs";
    discogsReleaseId = Number(trimmed);
  } else {
    return {
      ok: false,
      status: 400,
      error: "expected a musicbrainz.org or discogs.com release URL, a release UUID, or a bare Discogs release id",
    };
  }

  const copy = await prisma.physicalCopy.findUnique({ where: { albumId_medium: { albumId, medium } } });
  if (!copy) {
    return { ok: false, status: 404, error: "no physical copy on this medium for this album yet — add one first" };
  }

  // Whichever source this link uses becomes the copy's canonical one — the
  // other id is cleared so a stale MusicBrainz link doesn't linger after
  // re-linking via Discogs (or vice versa) and confuse a future re-fetch.
  await prisma.physicalCopy.update({
    where: { id: copy.id },
    data: { releaseMbid, discogsReleaseId },
  });

  if (source === "musicbrainz") {
    await populatePhysicalReleaseFromMusicBrainz(copy, releaseMbid!);
  } else {
    await populatePhysicalReleaseFromDiscogs(copy, discogsReleaseId!);
  }

  const trackCount = await prisma.physicalTrack.count({ where: { physicalCopyId: copy.id } });
  return { ok: true, trackCount };
}

/**
 * Add a physical-only album from a MusicBrainz release/release-group URL —
 * for LPs (or unripped CDs) with no digital rip at all, so there's no
 * existing Album row (and possibly no existing Artist row) to attach to the
 * way applyManualAlbumMatch does. Creates whatever's missing (Artist
 * folder=null, Album owned=false, same shape as a gap-tracking placeholder)
 * and attaches the PhysicalCopy. If the release group turns out to already
 * have an Album row (owned digitally, or an existing back-catalogue
 * placeholder), the copy is just attached to it instead of creating a
 * duplicate.
 */
export async function createPhysicalOnlyAlbum(
  mb: string,
  medium: PhysicalMedium,
  fields: PhysicalFields,
): Promise<
  | { ok: true; album: { id: number; title: string; artistName: string; kind: string; year: number | null } }
  | { ok: false; status: number; error: string }
> {
  const urlMatch = MB_URL_RE.exec(mb);
  let entity: "release" | "release-group";
  let mbId: string;
  if (urlMatch) {
    entity = urlMatch[1].toLowerCase() as "release" | "release-group";
    mbId = urlMatch[2].toLowerCase();
  } else if (MB_UUID_RE.test(mb.trim())) {
    entity = "release-group";
    mbId = mb.trim().toLowerCase();
  } else {
    return { ok: false, status: 400, error: "expected a musicbrainz.org release/release-group URL or a release-group UUID" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rg: any;
  try {
    if (entity === "release") {
      const release = await mbFetch(`/release/${mbId}`, { inc: "release-groups" });
      const rgId = release["release-group"]?.id;
      if (!rgId) return { ok: false, status: 502, error: "release has no release-group" };
      rg = await mbFetch(`/release-group/${rgId}`, { inc: "artist-credits" });
    } else {
      rg = await mbFetch(`/release-group/${mbId}`, { inc: "artist-credits" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `MusicBrainz lookup failed: ${message}` };
  }
  // Only a release URL identifies a specific pressing — a release-group URL
  // or bare UUID (both handled above by falling into the release-group
  // branch) doesn't, so there's no tracklist/cover to attach in that case.
  const releaseMbid = entity === "release" ? mbId : null;

  const credit = rg["artist-credit"]?.[0]?.artist;
  if (!credit?.id || !credit?.name) {
    return { ok: false, status: 502, error: "release group has no artist credit" };
  }

  const existingAlbum = await prisma.album.findUnique({ where: { mbid: rg.id } });
  if (existingAlbum) {
    const copy = await prisma.physicalCopy.upsert({
      where: { albumId_medium: { albumId: existingAlbum.id, medium } },
      create: { albumId: existingAlbum.id, medium, releaseMbid, ...physicalCopyData(medium, fields) },
      // releaseMbid deliberately omitted here — this branch only ever knows
      // a release-group id, never a specific release, so blindly writing it
      // on every call would wipe out a real pressing link a previous
      // attachPhysicalRelease call set (e.g. a duplicate scan/retry of an
      // already-added barcode). A genuine re-link goes through
      // attachPhysicalRelease directly, which does mean to overwrite it.
      update: { ...physicalCopyData(medium, fields) },
    });
    if (releaseMbid) await populatePhysicalReleaseFromMusicBrainz(copy, releaseMbid);
    const artist = await prisma.artist.findUnique({ where: { id: existingAlbum.artistId } });
    return {
      ok: true,
      album: {
        id: existingAlbum.id,
        title: existingAlbum.title,
        artistName: artist?.name ?? credit.name,
        kind: existingAlbum.kind,
        year: existingAlbum.year,
      },
    };
  }

  let artist = await prisma.artist.findUnique({ where: { mbid: credit.id } });
  if (!artist) {
    artist = await prisma.artist.create({
      data: {
        name: credit.name,
        sortName: sortTitle(credit.name),
        folder: null,
        mbid: credit.id,
        disambiguation: credit.disambiguation || null,
        matchConfidence: "EXACT",
      },
    });
  }

  const kind = classifyAlbumKind(rg["primary-type"], rg["secondary-types"]);
  const { year, releaseDate } = parseReleaseDate(rg["first-release-date"]);
  const album = await prisma.album.create({
    data: {
      artistId: artist.id,
      title: rg.title,
      sortTitle: sortTitle(rg.title),
      year,
      releaseDate,
      mbid: rg.id,
      kind,
      owned: false,
      folder: null,
    },
  });
  const copy = await prisma.physicalCopy.create({
    data: { albumId: album.id, medium, releaseMbid, ...physicalCopyData(medium, fields) },
  });
  if (releaseMbid) await populatePhysicalReleaseFromMusicBrainz(copy, releaseMbid);

  // Best-effort cover fetch, same shape as fetchMissingCoversForArtist's
  // per-album try/catch — must never fail the add.
  try {
    const result = await fetchCover({
      id: album.id,
      mbid: album.mbid,
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
