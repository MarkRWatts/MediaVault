// GET /api/v1/music/playlists/:id — one playlist as a ready-made queue,
// same shape the web's playlist page fetches. getPlaylistDetail is already
// scoped to (userId, id) — a playlist id from another person's account
// simply doesn't exist here, same as the web.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getPlaylistDetail } from "@/lib/queries-playlists";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }

  const playlist = await getPlaylistDetail(gate.userId, id);
  if (!playlist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(playlist);
}
