// POST/PUT /api/v1/music/playlists/:id/items — the native app's twins of
// app/actions/music-state.ts's addTracksToPlaylist (append) and
// reorderPlaylistItems (replace the whole ordering, as PlaylistView's
// multi-item drag sends it). Both return the freshly-updated
// getPlaylistDetail rather than a bare status, so the app can refresh its
// queue/tracklist in one round trip instead of a mutate-then-refetch pair.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { readJsonObject } from "@/lib/validation";
import { getPlaylistDetail } from "@/lib/queries-playlists";
import { addTracksToPlaylist, reorderPlaylistItems } from "@/lib/music-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { AddPlaylistItemsBody, ReorderPlaylistItemsBody } from "@/lib/api-v1-types";

function parsePlaylistId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = parsePlaylistId(idParam);
  if (id === null) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { trackIds } = parsed.body as Partial<AddPlaylistItemsBody>;
  if (!Array.isArray(trackIds)) {
    return NextResponse.json({ error: "trackIds must be an array of numbers" }, { status: 400 });
  }

  try {
    const result = await addTracksToPlaylist(gate.userId, id, trackIds);
    if (result.added > 0) {
      revalidatePath(`/music/playlist/${id}`);
      revalidatePath("/", "layout");
    }
    // addTracksToPlaylist above already proved this playlist exists and is
    // the caller's, so this can't come back null.
    const detail = await getPlaylistDetail(gate.userId, id);
    return NextResponse.json(detail);
  } catch (err) {
    return apiV1Error(err);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = parsePlaylistId(idParam);
  if (id === null) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { itemIds } = parsed.body as Partial<ReorderPlaylistItemsBody>;
  if (!Array.isArray(itemIds)) {
    return NextResponse.json({ error: "itemIds must be an array of numbers" }, { status: 400 });
  }

  try {
    await reorderPlaylistItems(gate.userId, id, itemIds);
    revalidatePath(`/music/playlist/${id}`);
    revalidatePath("/", "layout");
    const detail = await getPlaylistDetail(gate.userId, id);
    return NextResponse.json(detail);
  } catch (err) {
    return apiV1Error(err);
  }
}
