// DELETE /api/v1/shows/:id/progress — the native app's "Reset Watch
// Status": the web's reset-viewed button (app/actions/film-state.ts's
// resetShowWatched) for the signed-in member's own progress on every
// episode of the show. Wraps resetShowWatched (src/lib/film-user-state.ts) and
// revalidates the same web paths the action does. Idempotent: resetting
// something never watched answers { cleared: 0 }.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireMemberOrResponse } from "@/lib/require-member";
import { resetShowWatched } from "@/lib/film-user-state";
import { apiV1Error } from "@/lib/api-v1-errors";
import type { ResetWatchedResponse } from "@/lib/api-v1-types";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid show id" }, { status: 400 });
  }

  try {
    const body: ResetWatchedResponse = await resetShowWatched(gate.userId, id);
    revalidatePath(`/shows/${id}`);
    revalidatePath("/shows");
    return NextResponse.json(body);
  } catch (err) {
    return apiV1Error(err);
  }
}
