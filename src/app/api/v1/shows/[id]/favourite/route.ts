// PUT/DELETE /api/v1/shows/:id/favourite — the show twin of
// /api/v1/films/:id/favourite; see that route's comment for the
// idempotent-PUT/DELETE reasoning. Wraps setShowFavourite
// (src/lib/film-user-state.ts) and revalidates the same web paths
// app/actions/film-state.ts's toggleShowFavourite does.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { setShowFavourite } from "@/lib/film-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { FavouriteResponse } from "@/lib/api-v1-types";

async function setFavourite(idParam: string, favourite: boolean) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid show id" }, { status: 400 });
  }

  try {
    const result = await setShowFavourite(gate.userId, id, favourite);
    revalidatePath(`/shows/${id}`);
    revalidatePath("/shows");
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
