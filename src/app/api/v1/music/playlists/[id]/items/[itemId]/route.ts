// DELETE /api/v1/music/playlists/:id/items/:itemId — the native app's
// twin of app/actions/music-state.ts's removePlaylistItem. Returns the
// freshly-updated getPlaylistDetail, same reasoning as the sibling items
// route, so the app can refresh in one round trip.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getPlaylistDetail } from "@/lib/queries-playlists";
import { removePlaylistItem } from "@/lib/music-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam, itemId: itemIdParam } = await ctx.params;
  const id = parseId(idParam);
  const itemId = parseId(itemIdParam);
  if (id === null) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }
  if (itemId === null) {
    return NextResponse.json({ error: "invalid item id" }, { status: 400 });
  }

  try {
    await removePlaylistItem(gate.userId, id, itemId);
    revalidatePath(`/music/playlist/${id}`);
    revalidatePath("/", "layout");
    const detail = await getPlaylistDetail(gate.userId, id);
    return NextResponse.json(detail);
  } catch (err) {
    return apiV1Error(err);
  }
}
