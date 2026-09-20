// GET /api/v1/shows — the app's Shows tab: the show grid plus the
// continue-watching row of in-progress episodes, in one call, mirroring
// /api/v1/films.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getShows, getContinueWatchingEpisodes } from "@/lib/queries";
import { prisma } from "@/lib/db";
import type { ShowsResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const [shows, continueWatching, favourites] = await Promise.all([
    getShows(gate.ageLimit),
    getContinueWatchingEpisodes(gate.userId, gate.ageLimit),
    // Ids only: the app already has every show's card in `shows`.
    prisma.showFavourite.findMany({ where: { userId: gate.userId }, orderBy: { createdAt: "desc" }, select: { showId: true } }),
  ]);

  const body: ShowsResponse = { shows, continueWatching, favouriteShowIds: favourites.map((f) => f.showId) };
  return NextResponse.json(body);
}
