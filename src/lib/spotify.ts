// Spotify Web API: artist photos only — there's no bio/profile text field
// on Spotify's artist object, so it slots into fetchArtistEnrichment's photo
// priority only (see artist-bio.ts); Discogs remains the bio source.
//
// Needs SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET — a free Spotify Developer
// app (Client Credentials flow: server-to-server, no user login/redirect).
// Unset means this tier is silently skipped, same convention as every other
// optional key in this app (DISCOGS_TOKEN, FANART_API_KEY, etc.).
//
// Matching is deliberately conservative: only an exact normalized-name hit
// is trusted (see matchSpotifyArtist). Unlike Discogs, there's no
// pre-existing resolved identity to lean on here, and a wrong artist's face
// on the tile is worse than no photo at all — a non-exact top hit is left
// unmatched rather than guessed at, and Discogs/Wikipedia remain as the
// fallback tiers when Spotify has nothing confident to offer. Once matched,
// the id is cached on Artist.spotifyId (see discogs.ts's
// enrichArtistBioAndImages) so the search/match step only runs once per
// artist, not on every enrich pass.

import { normalizeTitle } from "@/lib/parse";

const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const USER_AGENT = "MediaVault/1.4 (https://github.com/MarkRWatts/MediaVault)";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // 5s safety margin so a token doesn't expire mid-request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) return cachedToken.token;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return cachedToken.token;
  } catch {
    return null;
  }
}

async function spotifyFetch(pathname: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await getAccessToken();
  if (!token) return null;
  const url = new URL(`${SPOTIFY_API_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

interface SpotifyArtistHit {
  id: string;
  name: string;
  popularity: number;
  images?: { url: string; width: number; height: number }[];
}

function imagesByWidthDesc(images: SpotifyArtistHit["images"]): string[] {
  return (images ?? [])
    .slice()
    .sort((a, b) => b.width - a.width)
    .map((i) => i.url);
}

export interface SpotifyArtistMatch {
  spotifyId: string;
  imageUrls: string[]; // widest first
}

/** Returns true only when both credentials are configured — checked before
 *  attempting a search, so an unconfigured deployment never pays for a
 *  wasted round trip. */
export function isSpotifyConfigured(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/**
 * Search + conservative match. Ties among multiple exact-name hits (two
 * different artists who happen to share a name) are broken by Spotify's own
 * popularity score — the only ranking signal Spotify's search gives us.
 */
export async function matchSpotifyArtist(name: string): Promise<SpotifyArtistMatch | null> {
  const data = (await spotifyFetch("/search", { q: name, type: "artist", limit: "10" })) as {
    artists?: { items?: SpotifyArtistHit[] };
  } | null;
  const hits = data?.artists?.items ?? [];
  if (hits.length === 0) return null;

  const target = normalizeTitle(name);
  const exact = hits.filter((h) => normalizeTitle(h.name) === target);
  if (exact.length === 0) return null;

  const best = exact.slice().sort((a, b) => b.popularity - a.popularity)[0];
  return { spotifyId: best.id, imageUrls: imagesByWidthDesc(best.images) };
}

/** Re-fetch images for an already-resolved artist (Artist.spotifyId set) —
 *  skips the search/match step entirely on repeat enrich runs. */
export async function fetchSpotifyArtistImages(spotifyId: string): Promise<{ imageUrls: string[] } | null> {
  const data = (await spotifyFetch(`/artists/${spotifyId}`)) as SpotifyArtistHit | null;
  if (!data) return null;
  return { imageUrls: imagesByWidthDesc(data.images) };
}
