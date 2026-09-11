// GET /api/v1/films — the app's Movies tab: the "/" page's shelves plus the
// full grid, in one call (IOS_PLAN.md "A versioned native API"). Card
// fields only (LibraryFilm), same trim as /api/films (which stays put for
// tvOS until it moves onto this surface). Superseding rather than editing
// that route because the app also needs the shelves, which the tvOS one
// never did.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getLibraryFilms, getContinueWatchingFilms, getFavouriteFilms } from "@/lib/queries";
import type { FilmsResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const [{ films }, continueWatching, favourites] = await Promise.all([
    getLibraryFilms(),
    getContinueWatchingFilms(gate.userId),
    getFavouriteFilms(gate.userId),
  ]);

  const body: FilmsResponse = { shelves: { continueWatching, favourites }, films };
  return NextResponse.json(body);
}
