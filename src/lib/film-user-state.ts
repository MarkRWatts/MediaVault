// Per-viewer state and mutations for the film/show pages: whether this
// person has favourited the film/show (in progress or completed) that the
// "reset viewed" button could clear, the favourite toggle, and the reset.
//
// The favourite toggles used to live entirely in app/actions/film-state.ts.
// They moved here (IOS_PLAN.md "A versioned native API", "To share code
// rather than copy") so both the web's server action and /api/v1's
// favourite route call exactly the same validated logic; each caller
// resolves its own userId and does its own revalidatePath calls afterwards
// (a Next.js page-cache concern that belongs at the call site).
//
// Each favourite comes in a "set" and a "toggle" form, same split as
// music-user-state.ts: setXFavourite is the idempotent primitive the API's
// PUT/DELETE routes want; toggleXFavourite, what the web's heart button
// wants, reads the current state and calls set with the opposite.

import { prisma } from "@/lib/db";
import { WATCH_PROGRESS_MIN_SECS, seasonSortRank } from "@/lib/constants";
import { playbackEngine } from "@/lib/playback/engine-flag";

export interface FilmUserState {
  favourite: boolean;
  watched: boolean;
}

export async function getFilmUserState(userId: string, filmId: number, versionIds: number[]): Promise<FilmUserState> {
  const [favourite, progress] = await Promise.all([
    prisma.filmFavourite.findUnique({ where: { userId_filmId: { userId, filmId } }, select: { userId: true } }),
    versionIds.length > 0
      ? prisma.watchProgress.findFirst({ where: { userId, versionId: { in: versionIds } }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  return { favourite: favourite !== null, watched: progress !== null };
}

export async function getShowUserState(userId: string, showId: number): Promise<FilmUserState> {
  const [favourite, progress] = await Promise.all([
    prisma.showFavourite.findUnique({ where: { userId_showId: { userId, showId } }, select: { userId: true } }),
    prisma.watchProgress.findFirst({
      where: { userId, episodeFile: { episode: { season: { showId } } } },
      select: { id: true },
    }),
  ]);
  return { favourite: favourite !== null, watched: progress !== null };
}

// ---------------------------------------------------------------------------
// Favourite toggles
// ---------------------------------------------------------------------------

/** Set (idempotently) whether filmId is favourited for this person. */
export async function setFilmFavourite(userId: string, filmId: number, favourite: boolean): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(filmId)) throw new Error("invalid film id");
  const existing = await prisma.filmFavourite.findUnique({ where: { userId_filmId: { userId, filmId } } });
  if (favourite && !existing) {
    await prisma.filmFavourite.create({ data: { userId, filmId } });
  } else if (!favourite && existing) {
    await prisma.filmFavourite.delete({ where: { userId_filmId: { userId, filmId } } });
  }
  return { favourite };
}

export async function toggleFilmFavourite(userId: string, filmId: number): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(filmId)) throw new Error("invalid film id");
  const existing = await prisma.filmFavourite.findUnique({
    where: { userId_filmId: { userId, filmId } },
    select: { userId: true },
  });
  return setFilmFavourite(userId, filmId, existing === null);
}

/** Set (idempotently) whether showId is favourited for this person. */
export async function setShowFavourite(userId: string, showId: number, favourite: boolean): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(showId)) throw new Error("invalid show id");
  const existing = await prisma.showFavourite.findUnique({ where: { userId_showId: { userId, showId } } });
  if (favourite && !existing) {
    await prisma.showFavourite.create({ data: { userId, showId } });
  } else if (!favourite && existing) {
    await prisma.showFavourite.delete({ where: { userId_showId: { userId, showId } } });
  }
  return { favourite };
}

export async function toggleShowFavourite(userId: string, showId: number): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(showId)) throw new Error("invalid show id");
  const existing = await prisma.showFavourite.findUnique({
    where: { userId_showId: { userId, showId } },
    select: { userId: true },
  });
  return setShowFavourite(userId, showId, existing === null);
}

// ---------------------------------------------------------------------------
// Reset viewed
// ---------------------------------------------------------------------------

/** Drop this person's WatchProgress rows for every version of the film:
 *  no resume position, not watched, out of Continue watching. Their play
 *  history (PlayEvent) stays — it records what happened, not what's next. */
export async function resetFilmWatched(userId: string, filmId: number): Promise<{ cleared: number }> {
  if (!Number.isInteger(filmId)) throw new Error("invalid film id");
  const result = await prisma.watchProgress.deleteMany({ where: { userId, version: { filmId } } });
  return { cleared: result.count };
}

/** The same for every episode file of the show. */
export async function resetShowWatched(userId: string, showId: number): Promise<{ cleared: number }> {
  if (!Number.isInteger(showId)) throw new Error("invalid show id");
  const result = await prisma.watchProgress.deleteMany({
    where: { userId, episodeFile: { episode: { season: { showId } } } },
  });
  return { cleared: result.count };
}

/** For the Shows page's card overlays. */
export async function getShowIdsState(userId: string): Promise<{ favouriteIds: number[]; watchedIds: number[] }> {
  const [favs, progress] = await Promise.all([
    prisma.showFavourite.findMany({ where: { userId }, select: { showId: true } }),
    prisma.watchProgress.findMany({
      where: { userId, episodeFileId: { not: null } },
      select: { episodeFile: { select: { episode: { select: { season: { select: { showId: true } } } } } } },
    }),
  ]);
  const watched = new Set<number>();
  for (const p of progress) {
    const id = p.episodeFile?.episode.season.showId;
    if (typeof id === "number") watched.add(id);
  }
  return { favouriteIds: favs.map((f) => f.showId), watchedIds: [...watched] };
}

export interface NextEpisode {
  episodeFileId: number;
  label: string;
  /** The season it sits in, so the show page can open that season's fold
   *  rather than work it out from the label. */
  seasonNumber: number;
  /** They stopped part-way through this episode rather than finishing it, so
   *  the button offers to carry on rather than to start. The player picks the
   *  position itself from its own progress GET; this only decides the word. */
  resume: boolean;
}

/** The episode file to offer as the show's "Play": the one they're part-way
 *  through, else the first they haven't finished, else the opening episode.
 *  Null when the show has no playable file. */
export async function getNextEpisodeFile(
  userId: string | null,
  showId: number,
): Promise<NextEpisode | null> {
  // Same "is this file playable" gate as isFilePlayable (src/lib/playback/
  // engine-flag.ts), applied at the query level rather than filtered in
  // memory afterward: jellyfin wants a matched library item, local wants
  // nothing more than a completed probe.
  const playableFilter = playbackEngine() === "local" ? { videoCodec: { not: null } } : { jellyfinId: { not: null } };
  const files = await prisma.episodeFile.findMany({
    where: { episode: { season: { showId } }, ...playableFilter },
    select: {
      id: true,
      episode: { select: { episodeNumber: true, name: true, season: { select: { seasonNumber: true } } } },
      watchProgress: userId
        ? { where: { userId }, select: { completed: true, positionSecs: true, updatedAt: true } }
        : false,
    },
  });
  if (files.length === 0) return null;

  // Specials sort after every real season (seasonSortRank), so a first visit
  // offers S01E01 and an unwatched special only comes up once the run proper
  // is done. Ordering here rather than in the query because seasonNumber's
  // own ascending order is exactly what's wrong with it.
  const ordered = [...files].sort(
    (a, b) =>
      seasonSortRank(a.episode.season.seasonNumber) - seasonSortRank(b.episode.season.seasonNumber) ||
      a.episode.episodeNumber - b.episode.episodeNumber ||
      a.id - b.id,
  );

  const label = (f: (typeof ordered)[number]) =>
    `S${String(f.episode.season.seasonNumber).padStart(2, "0")}E${String(f.episode.episodeNumber).padStart(2, "0")}${f.episode.name ? ` · ${f.episode.name}` : ""}`;
  const progressOf = (f: (typeof ordered)[number]) => (Array.isArray(f.watchProgress) ? f.watchProgress[0] : undefined);

  // Something left half-watched beats the next unfinished episode, and the
  // most recent of those beats an older one: someone who stopped S02E05 last
  // night means to carry on with it, not to be sent back to the S01E03 they
  // skipped a year ago. The WATCH_PROGRESS_MIN_SECS floor is the same one
  // the Continue watching shelf uses — a few seconds of the wrong episode
  // isn't a sitting to resume.
  const started = ordered
    .map((file) => ({ file, progress: progressOf(file) }))
    .filter((row) => row.progress && !row.progress.completed && row.progress.positionSecs >= WATCH_PROGRESS_MIN_SECS)
    .sort((a, b) => b.progress!.updatedAt.getTime() - a.progress!.updatedAt.getTime())[0];
  if (started)
    return {
      episodeFileId: started.file.id,
      label: label(started.file),
      seasonNumber: started.file.episode.season.seasonNumber,
      resume: true,
    };

  // Otherwise the first they haven't finished — and if they've finished the
  // lot, the opening episode, so the button restarts the series rather than
  // landing them on a special.
  const next = ordered.find((f) => !progressOf(f)?.completed) ?? ordered[0];
  return {
    episodeFileId: next.id,
    label: label(next),
    seasonNumber: next.episode.season.seasonNumber,
    resume: false,
  };
}
