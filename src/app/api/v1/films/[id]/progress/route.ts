// DELETE /api/v1/films/:id/progress — the native app's "Reset Watch
// Status": the web's reset-viewed button (app/actions/film-state.ts's
// resetFilmWatched) for the signed-in member's own progress on every
// version of the film. Wraps resetFilmWatched (src/lib/film-user-state.ts) and
// revalidates the same web paths the action does. Idempotent: resetting
// something never watched answers { cleared: 0 }.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { resetFilmWatched } from "@/lib/film-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { ResetWatchedResponse } from "@/lib/api-v1-types";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid film id" }, { status: 400 });
  }

  try {
    const body: ResetWatchedResponse = await resetFilmWatched(gate.userId, id);
    revalidatePath(`/film/${id}`);
    revalidatePath("/");
    revalidatePath("/films");
    return NextResponse.json(body);
  } catch (err) {
    return apiV1Error(err);
  }
}
