// GET /api/v1/shows/:id — a show's detail screen: seasons and episodes with
// each file's `playable` (has a jellyfinId, same rule as film versions —
// see /api/v1/films/:id), the viewer's favourite state, and their saved
// position on each episode file.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getShowDetail } from "@/lib/queries";
import { getShowUserState } from "@/lib/film-user-state";
import { prisma } from "@/lib/db";
import type { ShowDetailResponse, SeasonV1, EpisodeFileProgress } from "@/lib/api-v1-types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid show id" }, { status: 400 });
  }

  const show = await getShowDetail(id);
  if (!show) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const fileIds = show.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files.map((f) => f.id)));
  const [userState, progressRows] = await Promise.all([
    getShowUserState(gate.userId, show.id),
    fileIds.length > 0
      ? prisma.watchProgress.findMany({
          where: { userId: gate.userId, episodeFileId: { in: fileIds } },
          select: { episodeFileId: true, positionSecs: true, completed: true },
        })
      : Promise.resolve([]),
  ]);

  const seasons: SeasonV1[] = show.seasons.map((s) => ({
    ...s,
    episodes: s.episodes.map((e) => ({
      ...e,
      files: e.files.map((f) => ({ ...f, playable: f.jellyfinId !== null })),
    })),
  }));
  const progress: EpisodeFileProgress[] = progressRows.map((p) => ({
    // episodeFileId is non-null by construction (queried `in: fileIds`).
    episodeFileId: p.episodeFileId!,
    positionSecs: p.positionSecs,
    completed: p.completed,
  }));

  const body: ShowDetailResponse = { ...show, seasons, favourite: userState.favourite, progress };
  return NextResponse.json(body);
}
