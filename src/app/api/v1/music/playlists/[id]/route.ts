// GET/PATCH/DELETE /api/v1/music/playlists/:id. GET is one playlist as a
// ready-made queue, same shape the web's playlist page fetches —
// getPlaylistDetail is already scoped to (userId, id), so a playlist id
// from another person's account simply doesn't exist here, same as the
// web. PATCH/DELETE are the native app's twins of
// app/actions/music-state.ts's renamePlaylist/deletePlaylist.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { readJsonObject } from "@/lib/validation";
import { getPlaylistDetail } from "@/lib/queries-playlists";
import { renamePlaylist, deletePlaylist } from "@/lib/music-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { RenamePlaylistBody, RenamePlaylistResponse, DeletePlaylistResponse } from "@/lib/api-v1-types";

function parsePlaylistId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = parsePlaylistId(idParam);
  if (id === null) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { name } = parsed.body as Partial<RenamePlaylistBody>;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const renamed = await renamePlaylist(gate.userId, id, name);
    revalidatePath(`/music/playlist/${id}`);
    revalidatePath("/", "layout");
    const body: RenamePlaylistResponse = renamed;
    return NextResponse.json(body);
  } catch (err) {
    return apiV1Error(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = parsePlaylistId(idParam);
  if (id === null) {
    return NextResponse.json({ error: "invalid playlist id" }, { status: 400 });
  }

  try {
    await deletePlaylist(gate.userId, id);
    revalidatePath(`/music/playlist/${id}`);
    revalidatePath("/", "layout");
    revalidatePath("/music");
    const body: DeletePlaylistResponse = { ok: true };
    return NextResponse.json(body);
  } catch (err) {
    return apiV1Error(err);
  }
}
