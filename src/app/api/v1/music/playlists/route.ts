// GET /api/v1/music/playlists — the playlists rail: the signed-in
// person's own playlists, most recently touched first.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getUserPlaylists } from "@/lib/queries-playlists";
import type { PlaylistsResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const playlists = await getUserPlaylists(gate.userId);

  const body: PlaylistsResponse = { playlists };
  return NextResponse.json(body);
}
