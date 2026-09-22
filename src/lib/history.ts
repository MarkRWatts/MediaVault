// The read side of PlayEvent: the /history timeline and the two music
// numbers its summary tiles need. Every query here is scoped to one userId
// — a member's history is their own, and the route handler and the page
// both take the id from the session rather than from the request.
//
// PlayEvent stores ids, not titles (see its comment in schema.prisma), so a
// page of events is resolved in three batched lookups, one per media type,
// exactly as src/lib/play-log.ts's recentPlays does for the admin table.

import { prisma } from "@/lib/db";
import { formatLongTime } from "@/lib/format-time";

export type HistoryKind = "film" | "episode" | "track";

export const HISTORY_KINDS: readonly HistoryKind[] = ["film", "episode", "track"];

/** How many events a page of the timeline holds — the server-rendered first
 *  page and each "Show more" after it. */
export const HISTORY_PAGE_SIZE = 50;

export function isHistoryKind(value: string | null | undefined): value is HistoryKind {
  return value != null && (HISTORY_KINDS as readonly string[]).includes(value);
}

/** Which artwork component the row should draw. Decided here rather than in
 *  the row so the "episode still, or the show's poster when there isn't one"
 *  fallback lives next to the query that knows about both. */
export type HistoryArtwork =
  | { kind: "poster"; path: string | null; title: string; year: number | null }
  | { kind: "still"; path: string }
  | { kind: "cover"; albumId: number | null; version: number | null; title: string };

export interface HistoryEvent {
  id: number;
  kind: HistoryKind;
  /** The day heading this row belongs under: "Today", "Yesterday", or a
   *  date. Formatted on the server, like `time` below, because the browser's
   *  idea of the calendar can differ from the server's and React would call
   *  that a hydration mismatch. */
  day: string;
  time: string;
  title: string;
  /** Second line: the episode code and name, or the artist and album. */
  detail: string | null;
  /** "Watched" / "Stopped at 1:12:04" / "Listened". */
  state: string;
  href: string;
  artwork: HistoryArtwork;
}

export interface HistoryPage {
  events: HistoryEvent[];
  /** Feed back as ?before= for the next page; null when this was the last. */
  nextCursor: string | null;
}

// A cursor is the last row's (lastSeenAt, id) — the pair the timeline is
// ordered by. lastSeenAt alone would skip rows whenever two events share a
// millisecond, which happens the moment two tracks of one album are
// beaconed together.
function encodeCursor(row: { lastSeenAt: Date; id: number }): string {
  return `${row.lastSeenAt.getTime()}.${row.id}`;
}

function decodeCursor(cursor: string | null | undefined): { at: Date; id: number } | null {
  if (!cursor) return null;
  const [millis, id] = cursor.split(".");
  const at = Number(millis);
  const rowId = Number(id);
  if (!Number.isFinite(at) || !Number.isInteger(rowId)) return null;
  return { at: new Date(at), id: rowId };
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

// Spelled out rather than asked of Intl, which says "Sept" where the rest of
// the app says "Sep" (see formatDateDMY in format-time.ts).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local calendar day as "YYYY-MM-DD" — en-CA is the shortest way to ask
 *  Intl for ISO-ordered date parts. */
function dayKey(at: Date): string {
  return at.toLocaleDateString("en-CA");
}

function dayLabel(at: Date, now: Date): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 24 * 60 * 60_000))) return "Yesterday";
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

function watchState(completed: boolean, positionSecs: number | null): string {
  if (completed) return "Watched";
  if (positionSecs && positionSecs > 0) return `Stopped at ${formatLongTime(positionSecs)}`;
  return "Started";
}

export async function getHistoryPage(
  userId: string,
  opts: { kind?: HistoryKind | null; before?: string | null; take?: number } = {},
): Promise<HistoryPage> {
  const take = opts.take ?? HISTORY_PAGE_SIZE;
  const cursor = decodeCursor(opts.before);

  const rows = await prisma.playEvent.findMany({
    where: {
      userId,
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(cursor
        ? {
            OR: [
              { lastSeenAt: { lt: cursor.at } },
              { lastSeenAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const page = rows.slice(0, take);

  const idsOf = (kind: HistoryKind) => page.filter((r) => r.kind === kind).map((r) => r.itemId);
  const [versions, episodeFiles, tracks] = await Promise.all([
    prisma.version.findMany({
      where: { id: { in: idsOf("film") } },
      select: { id: true, film: { select: { id: true, title: true, year: true, posterPath: true } } },
    }),
    prisma.episodeFile.findMany({
      where: { id: { in: idsOf("episode") } },
      select: {
        id: true,
        episode: {
          select: {
            episodeNumber: true,
            name: true,
            stillPath: true,
            season: {
              select: {
                seasonNumber: true,
                show: { select: { id: true, title: true, posterPath: true } },
              },
            },
          },
        },
      },
    }),
    prisma.track.findMany({
      where: { id: { in: idsOf("track") } },
      select: {
        id: true,
        title: true,
        album: {
          select: {
            id: true,
            title: true,
            coverPath: true,
            updatedAt: true,
            artist: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const versionById = new Map(versions.map((v) => [v.id, v]));
  const episodeFileById = new Map(episodeFiles.map((f) => [f.id, f]));
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  const now = new Date();
  const events: HistoryEvent[] = [];
  for (const row of page) {
    const common = {
      id: row.id,
      day: dayLabel(row.lastSeenAt, now),
      time: timeFmt.format(row.lastSeenAt),
    };

    if (row.kind === "film") {
      const version = versionById.get(row.itemId);
      // The item has left the library since it was played. PlayEvent keeps
      // no foreign key to it on purpose, so the row outlives the file — but
      // a line with no artwork, no title and nowhere to go is a ghost, not
      // history, so it simply isn't shown.
      if (!version) continue;
      const { film } = version;
      events.push({
        ...common,
        kind: "film",
        title: film.year ? `${film.title} (${film.year})` : film.title,
        detail: null,
        state: watchState(row.completed, row.positionSecs),
        href: `/film/${film.id}`,
        artwork: { kind: "poster", path: film.posterPath, title: film.title, year: film.year },
      });
      continue;
    }

    if (row.kind === "episode") {
      const file = episodeFileById.get(row.itemId);
      if (!file) continue;
      const { episode } = file;
      const { show } = episode.season;
      const code = episodeCode(episode.season.seasonNumber, episode.episodeNumber);
      events.push({
        ...common,
        kind: "episode",
        title: show.title,
        detail: episode.name ? `${code} · ${episode.name}` : code,
        state: watchState(row.completed, row.positionSecs),
        href: `/shows/${show.id}`,
        artwork: episode.stillPath
          ? { kind: "still", path: episode.stillPath }
          : { kind: "poster", path: show.posterPath, title: show.title, year: null },
      });
      continue;
    }

    const track = trackById.get(row.itemId);
    if (!track) continue;
    const { album } = track;
    events.push({
      ...common,
      kind: "track",
      title: track.title,
      detail: `${album.artist.name} · ${album.title}`,
      state: "Listened",
      href: `/music/album/${album.id}`,
      artwork: {
        kind: "cover",
        albumId: album.coverPath != null ? album.id : null,
        version: album.coverPath != null ? album.updatedAt.getTime() : null,
        title: album.title,
      },
    });
  }

  // The cursor comes from the last RAW row, not the last rendered one:
  // skipping a departed item must not strand the rows behind it.
  return { events, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

export interface ListeningTotals {
  /** Distinct tracks with at least one play. */
  tracksPlayed: number;
  /** Sittings, so an album played twice in a week counts twice. */
  trackPlays: number;
}

export async function getListeningTotals(userId: string): Promise<ListeningTotals> {
  const [trackPlays, distinct] = await Promise.all([
    prisma.playEvent.count({ where: { userId, kind: "track" } }),
    prisma.playEvent.findMany({
      where: { userId, kind: "track" },
      distinct: ["itemId"],
      select: { itemId: true },
    }),
  ]);
  return { tracksPlayed: distinct.length, trackPlays };
}
