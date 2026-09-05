"use server";

// Film-page actions on the signed-in person's own state: favourite toggle
// and "reset viewed" (drop their WatchProgress rows for every version of
// the film, which also takes it out of Continue watching). Both re-render
// the film page and the home page's rows.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

async function currentUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) throw new Error("not signed in");
  return userId;
}

export async function toggleFilmFavourite(filmId: number): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(filmId)) throw new Error("invalid film id");
  const userId = await currentUserId();
  const existing = await prisma.filmFavourite.findUnique({ where: { userId_filmId: { userId, filmId } } });
  if (existing) {
    await prisma.filmFavourite.delete({ where: { userId_filmId: { userId, filmId } } });
  } else {
    await prisma.filmFavourite.create({ data: { userId, filmId } });
  }
  revalidatePath(`/film/${filmId}`);
  revalidatePath("/");
  return { favourite: !existing };
}

export async function resetFilmWatched(filmId: number): Promise<{ cleared: number }> {
  if (!Number.isInteger(filmId)) throw new Error("invalid film id");
  const userId = await currentUserId();
  const result = await prisma.watchProgress.deleteMany({ where: { userId, version: { filmId } } });
  revalidatePath(`/film/${filmId}`);
  revalidatePath("/");
  return { cleared: result.count };
}

export async function toggleShowFavourite(showId: number): Promise<{ favourite: boolean }> {
  if (!Number.isInteger(showId)) throw new Error("invalid show id");
  const userId = await currentUserId();
  const existing = await prisma.showFavourite.findUnique({ where: { userId_showId: { userId, showId } } });
  if (existing) {
    await prisma.showFavourite.delete({ where: { userId_showId: { userId, showId } } });
  } else {
    await prisma.showFavourite.create({ data: { userId, showId } });
  }
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/shows");
  return { favourite: !existing };
}

/** Drop the person's WatchProgress rows for every episode file of the show. */
export async function resetShowWatched(showId: number): Promise<{ cleared: number }> {
  if (!Number.isInteger(showId)) throw new Error("invalid show id");
  const userId = await currentUserId();
  const result = await prisma.watchProgress.deleteMany({
    where: { userId, episodeFile: { episode: { season: { showId } } } },
  });
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/shows");
  return { cleared: result.count };
}
