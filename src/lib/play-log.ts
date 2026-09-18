// Anonymous play log (see PlayLog in prisma/schema.prisma): what was played
// and on which day — never who, never when within the day. The per-user
// side of the same event is AuditLog's content-free "video.playback" /
// "audio.playback" row; the two are kept unjoinable on purpose, so nothing
// here may gain a user id, a timestamp, or per-play rows.

import { prisma } from "@/lib/db";

export type PlayKind = "film" | "episode" | "track";

// Same opportunistic sweep as src/lib/audit.ts: a year of history, checked
// once every SWEEP_EVERY writes. "YYYY-MM-DD" strings compare in date order.
const RETENTION_DAYS = 365;
const SWEEP_EVERY = 200;
let writesSinceSweep = 0;

/** Server-local calendar day, "YYYY-MM-DD". */
export function playLogDay(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Never throws — like logAudit, a logging failure must not fail playback. */
export async function logPlay(kind: PlayKind, itemId: number): Promise<void> {
  try {
    const day = playLogDay();
    await prisma.playLog.upsert({
      where: { day_kind_itemId: { day, kind, itemId } },
      create: { day, kind, itemId },
      update: { plays: { increment: 1 } },
    });
    if (++writesSinceSweep >= SWEEP_EVERY) {
      writesSinceSweep = 0;
      const cutoff = playLogDay(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000));
      await prisma.playLog.deleteMany({ where: { day: { lt: cutoff } } });
    }
  } catch {
    // Swallowed deliberately — see above.
  }
}

export interface PlayLogRow {
  day: string;
  kind: PlayKind;
  itemId: number;
  plays: number;
  /** Display title and file name; null once the item has left the library. */
  title: string | null;
  fileName: string | null;
}

/** The newest rows for /admin, titles resolved at read time (the table
 *  stores ids only). Ordered by day, then kind and id — never by insertion
 *  order, which is the one thing here that could be lined up against
 *  AuditLog's timestamps. */
export async function recentPlays(take = 200): Promise<PlayLogRow[]> {
  const rows = await prisma.playLog.findMany({
    orderBy: [{ day: "desc" }, { kind: "asc" }, { itemId: "asc" }],
    take,
  });
  const ids = (kind: PlayKind) => rows.filter((r) => r.kind === kind).map((r) => r.itemId);
  const [versions, episodeFiles, tracks] = await Promise.all([
    prisma.version.findMany({
      where: { id: { in: ids("film") } },
      select: { id: true, fileName: true, film: { select: { title: true, year: true } } },
    }),
    prisma.episodeFile.findMany({
      where: { id: { in: ids("episode") } },
      select: {
        id: true,
        fileName: true,
        episode: {
          select: {
            episodeNumber: true,
            name: true,
            season: { select: { seasonNumber: true, show: { select: { title: true } } } },
          },
        },
      },
    }),
    prisma.track.findMany({
      where: { id: { in: ids("track") } },
      select: { id: true, fileName: true, title: true, album: { select: { title: true, artist: { select: { name: true } } } } },
    }),
  ]);

  const resolved = new Map<string, { title: string; fileName: string }>();
  for (const v of versions) {
    resolved.set(`film:${v.id}`, { title: v.film.year ? `${v.film.title} (${v.film.year})` : v.film.title, fileName: v.fileName });
  }
  for (const f of episodeFiles) {
    const { episode } = f;
    const code = `S${String(episode.season.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
    resolved.set(`episode:${f.id}`, {
      title: `${episode.season.show.title} ${code}${episode.name ? ` — ${episode.name}` : ""}`,
      fileName: f.fileName,
    });
  }
  for (const t of tracks) {
    resolved.set(`track:${t.id}`, { title: `${t.album.artist.name} — ${t.title} (${t.album.title})`, fileName: t.fileName });
  }

  return rows.map((r) => {
    const hit = resolved.get(`${r.kind}:${r.itemId}`);
    return { day: r.day, kind: r.kind as PlayKind, itemId: r.itemId, plays: r.plays, title: hit?.title ?? null, fileName: hit?.fileName ?? null };
  });
}
