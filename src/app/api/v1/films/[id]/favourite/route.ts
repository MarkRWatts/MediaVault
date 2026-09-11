// PUT/DELETE /api/v1/films/:id/favourite — the native app's twin of the
// web's heart button (app/actions/film-state.ts's toggleFilmFavourite),
// but idempotent rather than a toggle: PUT always ends with the film
// favourited, DELETE always ends with it not, so a client can set the
// state it wants without first fetching the current one. Wraps
// setFilmFavourite (src/lib/film-user-state.ts) and revalidates the same
// web paths the toggle action does, so a heart tapped in the app shows on
// the web's next render.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { setFilmFavourite } from "@/lib/film-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { FavouriteResponse } from "@/lib/api-v1-types";

async function setFavourite(idParam: string, favourite: boolean) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid film id" }, { status: 400 });
  }

  try {
    const result = await setFilmFavourite(gate.userId, id, favourite);
    revalidatePath(`/film/${id}`);
    revalidatePath("/");
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
