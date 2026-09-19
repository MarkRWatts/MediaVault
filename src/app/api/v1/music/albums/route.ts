// GET /api/v1/music/albums — every album with something to play, by
// artist then title: the app's Music tab "Albums" grid. No paging, same
// as the rest of /api/v1.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getPlayableAlbums } from "@/lib/queries-music";
import type { AlbumsResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const body: AlbumsResponse = { albums: await getPlayableAlbums() };
  return NextResponse.json(body);
}
