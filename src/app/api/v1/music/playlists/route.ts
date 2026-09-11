// GET/POST /api/v1/music/playlists — GET is the playlists rail: the
// signed-in person's own playlists, most recently touched first. POST is
// the native app's twin of app/actions/music-state.ts's createPlaylist.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { readJsonObject } from "@/lib/validation";
import { getUserPlaylists, type PlaylistSummary } from "@/lib/queries-playlists";
import { createPlaylist } from "@/lib/music-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { PlaylistsResponse, CreatePlaylistBody } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const playlists = await getUserPlaylists(gate.userId);

  const body: PlaylistsResponse = { playlists };
  return NextResponse.json(body);
}

export async function POST(req: Request) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { name } = parsed.body as Partial<CreatePlaylistBody>;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const created = await createPlaylist(gate.userId, name);
    revalidatePath(`/music/playlist/${created.id}`);
    revalidatePath("/", "layout");
    // A fresh playlist has no tracks and no cover yet — build the summary
    // rather than round-tripping through getUserPlaylists for one row.
    const summary: PlaylistSummary = {
      id: created.id,
      name: created.name,
      trackCount: 0,
      coverAlbumId: null,
      coverVersion: null,
    };
    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    return apiV1Error(err);
  }
}
