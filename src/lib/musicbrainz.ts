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
import { fetchCover } from "@/lib/cover-art";

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "filmDB/1.3 (https://github.com/MarkRWatts/filmDB)";
// MusicBrainz's API ToS caps unauthenticated clients at 1 request/second,
// enforced globally (not per-endpoint) — every ws/2 call funnels through
// mbFetch, which gates on a shared "earliest next call" clock rather than a
// flat post-call sleep (tmdb.ts's approach): TMDB has no stated hard cap, but
// MusicBrainz does, so a fixed-interval scheduler is the safer choice here.
const MIN_INTERVAL_MS = 1000;
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
    const res = await fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
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

  // Pass 1: attach mbid/year/releaseDate/kind to owned albums, matched either
  // by an mbid already recorded from a prior run (idempotent) or by
  // normalized title (extends normalizeTitle-style matching, see
  // Pre-pass — ordinal disambiguation for identically-titled release groups.
  // Some artists have several albums with the SAME title (Peter Gabriel's
  // first four are all "Peter Gabriel"); the owner's folders disambiguate
  // with a numeric tag — "Peter Gabriel (3)" — which normalizeAlbumTitle
  // strips, making the bare title-match pairing arbitrary. When an owned
  // album carries a trailing "(N)"/"[N]" and 2+ release groups share its
  // normalized title, treat N as a 1-based index into that group's
  // best-kind subset sorted by first release date: (1)=1977 Car,
  // (3)=1980 Melt, (4)=1982 Security.
  const rgsByNormTitle = new Map<string, typeof releaseGroups>();
  for (const rg of releaseGroups) {
    const t = normalizeAlbumTitle(rg.title ?? "");
    const arr = rgsByNormTitle.get(t);
    if (arr) arr.push(rg);
    else rgsByNormTitle.set(t, [rg]);
  }
  for (const a of ownedAlbums) {
    if (claimedOwnedIds.has(a.id)) continue;
    const ordMatch = /[([](\d{1,2})[)\]]\s*$/.exec(a.title);
    if (!ordMatch) continue;
    const ordinal = Number(ordMatch[1]);
    const group = rgsByNormTitle.get(normalizeAlbumTitle(a.title));
    if (!group || group.length < 2) continue;
    const bestRank = Math.min(...group.map(rgKindRank));
    const candidates = group
      .filter((rg) => rgKindRank(rg) === bestRank)
      .slice()
      .sort((x, y) => (x["first-release-date"] ?? "9999").localeCompare(y["first-release-date"] ?? "9999"));
    const rg = candidates[ordinal - 1];
    if (!rg || claimedRgIds.has(rg.id)) continue;

    const kind = classifyAlbumKind(rg["primary-type"], rg["secondary-types"]);
    const { year, releaseDate } = parseReleaseDate(rg["first-release-date"]);
    const mbidChanged = a.mbid !== rg.id;
    const holder = await prisma.album.findUnique({ where: { mbid: rg.id } });
    if (holder && holder.id !== a.id) {
      if (!holder.owned) {
        await prisma.album.delete({ where: { id: holder.id } });
      } else {
        continue; // two owned albums claiming one release group — leave for review
      }
    }
    const invalidateCover = mbidChanged && a.mbid != null && a.coverSource !== "embedded" && a.coverSource !== "manual";
    await prisma.album.update({
      where: { id: a.id },
      data: { mbid: rg.id, year, releaseDate, kind, ...(invalidateCover ? { coverPath: null, coverSource: null } : {}) },
    });
    claimedRgIds.add(rg.id);
    claimedOwnedIds.add(a.id);
    a.mbid = rg.id;
    a.kind = kind;
    log.push(`Ordinal-matched "${a.title}" (${artistName}) to release-group ${rg.id} (${rg["first-release-date"] ?? "?"})`);
  }

  // Pass 1: attach mbid/year/releaseDate/kind to owned albums, matched either
  // by an mbid already recorded from a prior run (idempotent) or by
  // normalized title (extends normalizeTitle-style matching, see
  // normalizeAlbumTitle above).
  for (const rg of releaseGroups) {
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

    if (!owned.mbid) {
      // Another row may already hold this release-group id: a missing-album
      // placeholder from a prior run (reclaim it — the album on disk takes
      // its place) or a genuine second owned album (never merge on a title
      // match alone — flag it and leave both untouched, mirroring tmdb.ts's
      // caution around search-based collisions).
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
    const removed = await prisma.album.deleteMany({ where: { artistId, owned: false } });
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
  // from album/ep/studio).
  const seenStudioMbids = new Set(
    releaseGroups
      .filter((rg) => classifyAlbumKind(rg["primary-type"], rg["secondary-types"]) === "STUDIO")
      .map((rg) => rg.id as string),
  );
  const stalePlaceholders = await prisma.album.findMany({ where: { artistId, owned: false, mbid: { not: null } } });
  for (const stale of stalePlaceholders) {
    if (stale.mbid && !seenStudioMbids.has(stale.mbid)) {
      await prisma.album.delete({ where: { id: stale.id } });
      log.push(`Removed vanished back-catalogue placeholder "${stale.title}" for "${artistName}"`);
    }
  }

  await fetchMissingCoversForArtist(artistId, artistName, log);
}

// --- Per-artist driver ---

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

  if (!mbid) return; // stays UNMATCHED — nothing to reconcile against

  await reconcileArtistAlbums(artist.id, artist.name, mbid, log);
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
