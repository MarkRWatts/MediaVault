// Jellyfin integration: match the same movie share indexed by filmDB against
// the Jellyfin server's library items so film detail pages can link straight
// into playback. Degrades gracefully with no JELLYFIN_URL/JELLYFIN_API_KEY.
//
// Path matching gotcha: Jellyfin (running on Linux) reports NFC-normalized
// Unicode paths; some of filmDB's Version.filePath values came from a macOS
// scan and are NFD-normalized (e.g. "Léon" as "e" + combining acute accent).
// Both sides MUST be run through String.prototype.normalize("NFC") before
// comparison, or accented filenames silently fail to match.

import { prisma } from "@/lib/db";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";

const DEFAULT_MOVIES_PREFIX = "/media/Movies/";
const PROGRESS_UPDATE_EVERY = 25;

interface MediaFolder {
  Id: string;
  Name: string;
  CollectionType?: string;
}

interface JellyfinItem {
  Id: string;
  Name: string;
  Path?: string;
}

export function jellyfinConfigured(): boolean {
  return Boolean(process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY);
}

function baseUrl(): string {
  const url = process.env.JELLYFIN_URL;
  if (!url) throw new Error("JELLYFIN_URL not set");
  return url.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const key = process.env.JELLYFIN_API_KEY;
  if (!key) throw new Error("JELLYFIN_API_KEY not set");
  return { Authorization: `MediaBrowser Token="${key}"` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jellyfinFetch(pathname: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${baseUrl()}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Jellyfin ${pathname} -> HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

async function getMoviesLibraryId(): Promise<string> {
  const data = await jellyfinFetch("/Library/MediaFolders");
  const folders: MediaFolder[] = data.Items ?? [];
  const movies = folders.find((f) => f.CollectionType === "movies");
  if (!movies) throw new Error('No Jellyfin library with CollectionType "movies" found');
  return movies.Id;
}

async function getAllMovieItems(parentId: string): Promise<JellyfinItem[]> {
  const data = await jellyfinFetch("/Items", {
    ParentId: parentId,
    IncludeItemTypes: "Movie",
    Recursive: "true",
    Fields: "Path,ProviderIds",
  });
  return data.Items ?? [];
}

/** Fire the library refresh and return immediately — we don't wait for the
 * (potentially slow) scan to finish; the item list fetched right after may
 * be very slightly stale, which is an acceptable tradeoff here. */
async function triggerLibraryRefresh(log: string[]): Promise<void> {
  try {
    await fetch(`${baseUrl()}/Library/Refresh`, { method: "POST", headers: authHeaders() });
    log.push("Triggered Jellyfin library refresh (not waiting for completion — item list may be slightly stale)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Failed to trigger Jellyfin library refresh: ${message}`);
  }
}

/** Strip everything through the configured movies prefix, leaving the path
 * relative to MOVIES_PATH the same way Version.filePath is stored. */
function relativizePath(jellyfinPath: string): string | null {
  const prefix = process.env.JELLYFIN_MOVIES_PREFIX ?? DEFAULT_MOVIES_PREFIX;
  const idx = jellyfinPath.indexOf(prefix);
  if (idx === -1) return null;
  return jellyfinPath.slice(idx + prefix.length);
}

async function doJellyfinSync(runId: number): Promise<void> {
  const log: string[] = [];

  await triggerLibraryRefresh(log);

  const parentId = await getMoviesLibraryId();
  const items = await getAllMovieItems(parentId);

  const total = items.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Matching ${total} Jellyfin items` });

  const versions = await prisma.version.findMany({ select: { id: true, filePath: true, jellyfinId: true } });
  const versionByNormPath = new Map(versions.map((v) => [v.filePath.normalize("NFC"), v]));
  const matchedVersionIds = new Set<number>();

  let matched = 0;
  const unmatchedInJellyfin: string[] = [];
  let completed = 0;

  for (const item of items) {
    completed++;
    if (item.Path) {
      const relPath = relativizePath(item.Path);
      const normPath = relPath?.normalize("NFC");
      const version = normPath ? versionByNormPath.get(normPath) : undefined;
      if (version) {
        if (version.jellyfinId !== item.Id) {
          await prisma.version.update({ where: { id: version.id }, data: { jellyfinId: item.Id } });
        }
        matchedVersionIds.add(version.id);
        matched++;
      } else {
        unmatchedInJellyfin.push(item.Name ?? item.Path);
      }
    } else {
      unmatchedInJellyfin.push(item.Name ?? `(item ${item.Id})`);
    }

    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message: `Matched ${matched}/${completed}` });
    }
  }

  // Any version we didn't match this run: unmatched-in-filmDB, and clear a
  // stale jellyfinId if it had one from a previous sync.
  const unmatchedInFilmDb: string[] = [];
  for (const v of versions) {
    if (matchedVersionIds.has(v.id)) continue;
    unmatchedInFilmDb.push(v.filePath);
    if (v.jellyfinId !== null) {
      await prisma.version.update({ where: { id: v.id }, data: { jellyfinId: null } });
    }
  }

  log.push(`Matched ${matched} of ${versions.length} filmDB versions to Jellyfin items`);
  if (unmatchedInFilmDb.length > 0) {
    log.push(`Unmatched in filmDB (${unmatchedInFilmDb.length}): ${unmatchedInFilmDb.join(", ")}`);
  }
  if (unmatchedInJellyfin.length > 0) {
    log.push(`Unmatched in Jellyfin (${unmatchedInJellyfin.length}): ${unmatchedInJellyfin.join(", ")}`);
  }

  await finishRun(runId, log, `Matched ${matched}/${versions.length}`);
}

/**
 * Kick off a Jellyfin sync. Resolves quickly once the run is registered (or
 * an existing run is found, or the run is failed immediately for missing
 * config) — the actual Jellyfin/DB work continues in the background and is
 * not awaited here.
 */
export async function runJellyfinSync(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("JELLYFIN");
  if (!started) return { runId: run.id, started: false };

  if (!jellyfinConfigured()) {
    await failRun(run.id, new Error("JELLYFIN_URL/JELLYFIN_API_KEY not set"));
    return { runId: run.id, started: true };
  }

  doJellyfinSync(run.id).catch(async (err) => {
    console.error("[jellyfin] sync failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[jellyfin] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}

// ---------------------------------------------------------------------------
// Server info / deep links
// ---------------------------------------------------------------------------

export interface JellyfinServerInfo {
  serverId: string;
}

let cachedServerInfo: JellyfinServerInfo | null = null;

/** Cached fetch of the Jellyfin server's public id, used to build deep links.
 * Returns null (and logs) if unconfigured or unreachable — callers should
 * simply omit the link rather than surface an error. */
export async function getJellyfinServerInfo(): Promise<JellyfinServerInfo | null> {
  if (!jellyfinConfigured()) return null;
  if (cachedServerInfo) return cachedServerInfo;

  try {
    const res = await fetch(`${baseUrl()}/System/Info/Public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.Id) return null;
    cachedServerInfo = { serverId: data.Id as string };
    return cachedServerInfo;
  } catch (err) {
    console.error("[jellyfin] failed to fetch server info:", err);
    return null;
  }
}

/** Deep link into the Jellyfin web client for a given item. */
export function jellyfinPlayUrl(itemId: string, serverId: string): string {
  return `${baseUrl()}/web/#/details?id=${itemId}&serverId=${serverId}`;
}
