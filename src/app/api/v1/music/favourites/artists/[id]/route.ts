// PUT/DELETE /api/v1/music/favourites/artists/:id — the native app's twin
// of the artist heart (app/actions/music-state.ts's toggleArtistFavourite),
// idempotent rather than a toggle (see /api/v1/films/:id/favourite's
// comment). Wraps setArtistFavourite (src/lib/music-user-state.ts), which
// still creates/removes the linked playlist exactly as the toggle does,
// and revalidates the same web paths the toggle action does.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { setArtistFavourite } from "@/lib/music-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { FavouriteResponse } from "@/lib/api-v1-types";

function revalidateFavourites(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/music");
  revalidatePath("/music/favourites");
  revalidatePath("/", "layout");
}

async function setFavourite(idParam: string, favourite: boolean) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid artist id" }, { status: 400 });
  }

  try {
    const result = await setArtistFavourite(gate.userId, id, favourite);
    revalidateFavourites(`/music/artist/${id}`);
    const body: FavouriteResponse = result;
    return NextResponse.json(body);
  } catch (err) {
    return apiV1Error(err);
  }
}

export async function PUT(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return setFavourite(id, true);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return setFavourite(id, false);
}
