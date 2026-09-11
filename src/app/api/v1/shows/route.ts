// GET /api/v1/shows — the app's Shows tab: the show grid plus the
// continue-watching row of in-progress episodes, in one call, mirroring
// /api/v1/films.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getShows, getContinueWatchingEpisodes } from "@/lib/queries";
import type { ShowsResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const [shows, continueWatching] = await Promise.all([getShows(), getContinueWatchingEpisodes(gate.userId)]);

  const body: ShowsResponse = { shows, continueWatching };
  return NextResponse.json(body);
}
