// Per-viewer state and mutations for the film/show pages: whether this
// person has favourited the film/show (in progress or completed) that the
// "reset viewed" button could clear, and the favourite toggle itself.
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

/** The episode file to offer as the show's "Play": the first owned episode
 *  (season/episode order) without a completed watch record for this person,
 *  else the very first. Null when the show has no playable file. */
export async function getNextEpisodeFile(
  userId: string | null,
  showId: number,
): Promise<{ episodeFileId: number; label: string } | null> {
  const files = await prisma.episodeFile.findMany({
    where: { episode: { season: { showId } }, jellyfinId: { not: null } },
    select: {
      id: true,
      episode: { select: { episodeNumber: true, name: true, season: { select: { seasonNumber: true } } } },
      watchProgress: userId ? { where: { userId }, select: { completed: true } } : false,
    },
    orderBy: [{ episode: { season: { seasonNumber: "asc" } } }, { episode: { episodeNumber: "asc" } }, { id: "asc" }],
  });
  if (files.length === 0) return null;
  const label = (f: (typeof files)[number]) =>
    `S${String(f.episode.season.seasonNumber).padStart(2, "0")}E${String(f.episode.episodeNumber).padStart(2, "0")}${f.episode.name ? ` · ${f.episode.name}` : ""}`;
  const next = files.find((f) => !(Array.isArray(f.watchProgress) && f.watchProgress.some((w) => w.completed))) ?? files[0];
  return { episodeFileId: next.id, label: label(next) };
}
