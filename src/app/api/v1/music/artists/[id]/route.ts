// GET /api/v1/music/artists/:id — an artist's page: the studio
// back-catalogue and owned shelf albums, plus the viewer's own heart on
// the artist and on any of their albums (for the album tiles' corner
// hearts, same as the web page).

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getArtistDetail } from "@/lib/queries-music";
import { getArtistUserState } from "@/lib/music-user-state";
import type { ArtistDetailResponse } from "@/lib/api-v1-types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid artist id" }, { status: 400 });
  }

  const artist = await getArtistDetail(id);
  if (!artist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const userState = await getArtistUserState(gate.userId, id);

  const body: ArtistDetailResponse = { ...artist, ...userState };
  return NextResponse.json(body);
}
