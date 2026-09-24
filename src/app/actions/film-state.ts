"use server";

// Film-page actions on the signed-in person's own state: favourite toggle
// and "reset viewed" (drop their WatchProgress rows for every version of
// the film, which also takes it out of Continue watching). Both re-render
// the film page and the home page's rows.
//
// The favourite toggles' logic now lives in src/lib/film-user-state.ts
// (IOS_PLAN.md "A versioned native API", "To share code rather than
// copy") so /api/v1's favourite routes call exactly the same code the app
// runs; that also moves their auth check onto requireMember() (real
// household membership, not just a session) to match every other server
// action — the film/show pages that render these buttons already gate on
// requireMemberOrRedirect, so nobody signed-in-but-membership-less could
// reach them anyway. "Reset viewed" moved the same way when the apps gained
// it (/api/v1/films/:id/progress and /api/v1/shows/:id/progress).

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/require-member";
import * as filmUserState from "@/lib/film-user-state";

export async function toggleFilmFavourite(filmId: number): Promise<{ favourite: boolean }> {
  const { userId } = await requireMember();
  const result = await filmUserState.toggleFilmFavourite(userId, filmId);
  revalidatePath(`/film/${filmId}`);
  revalidatePath("/");
  return result;
}

export async function resetFilmWatched(filmId: number): Promise<{ cleared: number }> {
  const { userId } = await requireMember();
  const result = await filmUserState.resetFilmWatched(userId, filmId);
  revalidatePath(`/film/${filmId}`);
  revalidatePath("/");
  return result;
}

export async function toggleShowFavourite(showId: number): Promise<{ favourite: boolean }> {
  const { userId } = await requireMember();
  const result = await filmUserState.toggleShowFavourite(userId, showId);
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/shows");
  return result;
}

/** Drop the person's WatchProgress rows for every episode file of the show. */
export async function resetShowWatched(showId: number): Promise<{ cleared: number }> {
  const { userId } = await requireMember();
  const result = await filmUserState.resetShowWatched(userId, showId);
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/shows");
  return result;
}
