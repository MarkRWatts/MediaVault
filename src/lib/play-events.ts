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

/** A report at or under this position, and behind where the last sitting
 *  had got to, is somebody starting again rather than carrying on. Only
 *  consulted for a finished item, and only when the caller has no
 *  `isNewPlay` of its own. */
const RESTART_POSITION_SECS = 60;

export interface RecordPlayEventInput {
  userId: string;
  kind: PlayEventKind;
  itemId: number;
  /** Where they had got to; omitted for tracks, which have no resume
   *  position worth keeping. */
  positionSecs?: number | null;
  completed?: boolean;
  /** The progress routes' own "this is the first report of a fresh player
   *  session" flag. Authoritative where it exists; where it doesn't, a
   *  rewatch is inferred from the position instead. */
  isNewPlay?: boolean;
}

/** Is this report the start of a new viewing of something already watched,
 *  rather than the tail of the sitting that finished it? Watching the
 *  credits, then restarting the film an hour later, must not turn the
 *  finished row back into an abandoned one — the timeline would lose a
 *  real "Watched". */
function isRestart(
  latest: { completed: boolean; positionSecs: number | null },
  position: number | undefined,
  isNewPlay: boolean | undefined,
): boolean {
  if (!latest.completed) return false;
  if (isNewPlay !== undefined) return isNewPlay;
  if (position === undefined) return false;
  return position <= RESTART_POSITION_SECS && position < (latest.positionSecs ?? Infinity);
}

/** Never throws — like logPlay and logAudit, a history write failing must
 *  not fail the playback report it rode in on. */
export async function recordPlayEvent({
  userId,
  kind,
  itemId,
  positionSecs,
  completed,
  isNewPlay,
}: RecordPlayEventInput): Promise<void> {
  try {
    const now = new Date();
    const position = positionSecs == null ? undefined : Math.max(0, Math.round(positionSecs));

    const latest = await prisma.playEvent.findFirst({
      where: { userId, kind, itemId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, lastSeenAt: true, completed: true, positionSecs: true },
    });

    if (
      latest &&
      now.getTime() - latest.lastSeenAt.getTime() < PLAY_EVENT_COALESCE_MS &&
      !isRestart(latest, position, isNewPlay)
    ) {
      await prisma.playEvent.update({
        where: { id: latest.id },
        data: {
          lastSeenAt: now,
          ...(position === undefined ? {} : { positionSecs: position }),
          // Completion only ever goes up within a sitting. The caller
          // recomputes it from the position on every report, so a pause
          // spent scrubbing backwards through a film that was already
          // finished would otherwise un-watch it.
          completed: latest.completed || (completed ?? false),
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
