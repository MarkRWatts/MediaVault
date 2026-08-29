// Roon-style artist enrichment: biography text, a portrait photo, and a wide
// backdrop image — multi-source with graceful fallback, cached to disk like
// Album.coverPath. Best-effort throughout (mirrors cover-art.ts's fetchCover
// contract): a failed/missing source just leaves that field unset, never
// throws, never blocks the wider music enrich run.
//
// Sources, in priority order:
//  - TheAudioDB (bio + thumb + fanart/banner), looked up directly by
//    MusicBrainz artist id. No signup needed at this app's scale — the
//    shared public test key "2" works fine; set AUDIODB_API_KEY to use a
//    personal one instead.
//  - Fanart.tv (better backdrop art specifically) — strictly requires a
//    free personal API key, no shared key exists, so this is skipped
//    entirely unless FANART_API_KEY is set.
//  - Wikipedia (bio extract + a thumbnail), looked up by artist name rather
//    than mbid — less precise than an MBID-keyed match, but the existing
//    iTunes cover fallback in cover-art.ts already accepts this tier of
//    imprecision, and it's the only source that needs no MusicBrainz match
//    at all.

import { promises as fs } from "node:fs";
import path from "node:path";

const AUDIODB_BASE = "https://www.theaudiodb.com/api/v1/json";
const FANART_BASE = "https://webservice.fanart.tv/v3/music";
const WIKIPEDIA_SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";

const POSTER_CACHE_DIR = process.env.POSTER_CACHE_DIR ?? "./data/posters";
const ARTISTS_DIR = path.join(POSTER_CACHE_DIR, "artists");
// Same floor as cover-art.ts's MIN_COVER_BYTES — catches a truncated
// download or a tiny placeholder served on a technicality 200.
const MIN_IMAGE_BYTES = 5 * 1024;

export type BioSource = "theaudiodb" | "wikipedia" | "manual";
export type ImageSource = "theaudiodb" | "fanart" | "wikipedia" | "manual";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return res.json();
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

async function cacheArtistImage(artistId: number, kind: "photo" | "backdrop", buf: Buffer): Promise<string> {
  const fileName = `${artistId}-${kind}.jpg`;
  await fs.mkdir(ARTISTS_DIR, { recursive: true });
  await fs.writeFile(path.join(ARTISTS_DIR, fileName), buf);
  return fileName;
}

interface AudioDbArtist {
  bio: string | null;
  thumbUrl: string | null;
  bannerUrl: string | null;
  fanartUrls: string[];
}

async function fetchAudioDbArtist(mbid: string): Promise<AudioDbArtist | null> {
  const key = process.env.AUDIODB_API_KEY || "2";
  try {
    const data = (await getJson(`${AUDIODB_BASE}/${key}/artist-mb.php?i=${mbid}`)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      artists?: any[];
    } | null;
    const a = data?.artists?.[0];
    if (!a) return null;
    return {
      bio: a.strBiography || null,
      thumbUrl: a.strArtistThumb || null,
      bannerUrl: a.strArtistBanner || null,
      fanartUrls: [a.strArtistFanart, a.strArtistFanart2, a.strArtistFanart3, a.strArtistFanart4].filter(
        (u): u is string => Boolean(u),
      ),
    };
  } catch {
    return null;
  }
}

interface FanartArtist {
  backgroundUrls: string[];
  bannerUrls: string[];
  thumbUrls: string[];
}

async function fetchFanartArtist(mbid: string): Promise<FanartArtist | null> {
  const key = process.env.FANART_API_KEY;
  if (!key) return null;
  try {
    const data = (await getJson(`${FANART_BASE}/${mbid}?api_key=${key}`)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      artistbackground?: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      musicbanner?: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      artistthumb?: any[];
    } | null;
    if (!data) return null;
    return {
      backgroundUrls: (data.artistbackground ?? []).map((i) => i.url).filter(Boolean),
      bannerUrls: (data.musicbanner ?? []).map((i) => i.url).filter(Boolean),
      thumbUrls: (data.artistthumb ?? []).map((i) => i.url).filter(Boolean),
    };
  } catch {
    return null;
  }
}

interface WikipediaSummary {
  extract: string | null;
  thumbnailUrl: string | null;
}

async function fetchWikipediaSummary(name: string): Promise<WikipediaSummary | null> {
  try {
    const data = (await getJson(`${WIKIPEDIA_SUMMARY_BASE}/${encodeURIComponent(name.replace(/ /g, "_"))}`)) as {
      type?: string;
      extract?: string;
      thumbnail?: { source?: string };
    } | null;
    // "disambiguation"/"no-extract" types mean this isn't a real article match.
    if (!data || !data.extract || data.type === "disambiguation") return null;
    return { extract: data.extract, thumbnailUrl: data.thumbnail?.source || null };
  } catch {
    return null;
  }
}

export interface ArtistEnrichmentTarget {
  id: number;
  mbid: string | null;
  name: string;
  needsBio: boolean;
  needsPhoto: boolean;
  needsBackdrop: boolean;
}

export interface ArtistEnrichmentResult {
  bio?: { text: string; source: BioSource };
  photo?: { fileName: string; source: ImageSource };
  backdrop?: { fileName: string; source: ImageSource };
}

/**
 * Fetch whichever of bio/photo/backdrop the caller says is missing (see
 * needsBio/needsPhoto/needsBackdrop) for one artist. Returns only the
 * pieces it actually found — the caller applies a partial update, same
 * convention as fetchCover's CoverResult. Never throws.
 */
export async function fetchArtistEnrichment(target: ArtistEnrichmentTarget): Promise<ArtistEnrichmentResult> {
  const result: ArtistEnrichmentResult = {};
  if (!target.needsBio && !target.needsPhoto && !target.needsBackdrop) return result;

  const audioDb = target.mbid ? await fetchAudioDbArtist(target.mbid) : null;
  const fanart = target.mbid ? await fetchFanartArtist(target.mbid) : null;
  // Wikipedia is a single request that can serve both bio and photo — only
  // fetch it once, lazily, and only if something still needs it.
  let wikipedia: WikipediaSummary | null | undefined;
  const getWikipedia = async () => {
    if (wikipedia === undefined) wikipedia = await fetchWikipediaSummary(target.name);
    return wikipedia;
  };

  if (target.needsBio) {
    if (audioDb?.bio) {
      result.bio = { text: audioDb.bio, source: "theaudiodb" };
    } else {
      const wiki = await getWikipedia();
      if (wiki?.extract) result.bio = { text: wiki.extract, source: "wikipedia" };
    }
  }

  if (target.needsPhoto) {
    const url = audioDb?.thumbUrl || fanart?.thumbUrls[0] || (await getWikipedia())?.thumbnailUrl;
    const source: ImageSource = audioDb?.thumbUrl ? "theaudiodb" : fanart?.thumbUrls[0] ? "fanart" : "wikipedia";
    if (url) {
      const buf = await downloadImage(url);
      if (buf) result.photo = { fileName: await cacheArtistImage(target.id, "photo", buf), source };
    }
  }

  if (target.needsBackdrop) {
    // Fanart.tv's backgrounds are purpose-shot wide art; prefer it over
    // TheAudioDB's fanart/banner when available.
    const url = fanart?.backgroundUrls[0] || fanart?.bannerUrls[0] || audioDb?.fanartUrls[0] || audioDb?.bannerUrl;
    const source: ImageSource = fanart?.backgroundUrls[0] || fanart?.bannerUrls[0] ? "fanart" : "theaudiodb";
    if (url) {
      const buf = await downloadImage(url);
      if (buf) result.backdrop = { fileName: await cacheArtistImage(target.id, "backdrop", buf), source };
    }
  }

  return result;
}
