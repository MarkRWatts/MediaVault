// Per-viewer state the film page's action row shows: whether this person
// has favourited the film, and whether they have any watch record for it
// (in progress or completed) that the "reset viewed" button could clear.

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
