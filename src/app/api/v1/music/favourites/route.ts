// GET /api/v1/music/favourites — the "/music/favourites" list as
// ready-made queue entries, newest heart first.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getFavouriteTracks } from "@/lib/queries-music";
import type { FavouriteTracksResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const tracks = await getFavouriteTracks(gate.userId);

  const body: FavouriteTracksResponse = { tracks };
  return NextResponse.json(body);
}
