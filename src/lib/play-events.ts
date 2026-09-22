// Per-user play history (PlayEvent in prisma/schema.prisma) — the write
// side of /history's timeline. Not to be confused with src/lib/play-log.ts,
// which counts the same plays anonymously for the household; the two are
// separate tables on purpose and neither is derived from the other.
//
// Every playback surface reports progress far more often than a person
// starts something: the video players ping every
// WATCH_PROGRESS_REPORT_INTERVAL_SECS and flush again on pause and close,
// and the music player beacons each track as it comes round in a queue. A
// row per report would make the timeline unreadable, so reports for the
// same item fold into the sitting they belong to.

import { prisma } from "@/lib/db";

/** Same vocabulary as PlayLog.kind, deliberately declared here rather than
 *  imported from play-log.ts: the anonymous log and this one are kept
 *  unjoinable, and that starts with not sharing a module. */
export type PlayEventKind = "film" | "episode" | "track";

/** How long a sitting may go quiet before the next report starts a fresh
 *  one. Six hours is long enough to cover the way people actually watch —
 *  a film paused over dinner, an album left running while the laptop
 *  sleeps — and short enough that tonight's episode never lands on the
 *  same line as yesterday's, since a gap that long always crosses the
 *  evening the timeline groups by. */
export const PLAY_EVENT_COALESCE_MS = 6 * 60 * 60_000;

export interface RecordPlayEventInput {
  userId: string;
  kind: PlayEventKind;
  itemId: number;
  /** Where they had got to; omitted for tracks, which have no resume
   *  position worth keeping. */
  positionSecs?: number | null;
  completed?: boolean;
}

/** Never throws — like logPlay and logAudit, a history write failing must
 *  not fail the playback report it rode in on. */
export async function recordPlayEvent({
  userId,
  kind,
  itemId,
  positionSecs,
  completed,
}: RecordPlayEventInput): Promise<void> {
  try {
    const now = new Date();
    const position = positionSecs == null ? undefined : Math.max(0, Math.round(positionSecs));

    const latest = await prisma.playEvent.findFirst({
      where: { userId, kind, itemId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, lastSeenAt: true, completed: true },
    });

    if (latest && now.getTime() - latest.lastSeenAt.getTime() < PLAY_EVENT_COALESCE_MS) {
      await prisma.playEvent.update({
        where: { id: latest.id },
        data: {
          lastSeenAt: now,
          ...(position === undefined ? {} : { positionSecs: position }),
          // The caller recomputes completion from the position on every
          // report, so a later report is always the better answer —
          // including when it says false because they rewound.
          completed: completed ?? latest.completed,
        },
      });
      return;
    }

    await prisma.playEvent.create({
      data: {
        userId,
        kind,
        itemId,
        startedAt: now,
        lastSeenAt: now,
        positionSecs: position ?? null,
        completed: completed ?? false,
      },
    });
  } catch {
    // Swallowed deliberately — see above.
  }
}
