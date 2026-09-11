// GET /api/v1/films/:id — a film's detail screen: versions with their
// audio tracks, `playable` (has a jellyfinId — the only versions the app's
// Jellyfin-brokered player can open, see IOS_PLAN.md "Video: nothing new"),
// the viewer's favourite state, and their saved position on each version
// (so a resume prompt doesn't need a second round trip once a version is
// picked).

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getFilmDetail } from "@/lib/queries";
import { getFilmUserState } from "@/lib/film-user-state";
import { prisma } from "@/lib/db";
import type { FilmDetailResponse, FilmVersionV1, VersionProgress } from "@/lib/api-v1-types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid film id" }, { status: 400 });
  }

  const film = await getFilmDetail(id);
  if (!film) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const versionIds = film.versions.map((v) => v.id);
  const [userState, progressRows] = await Promise.all([
    getFilmUserState(gate.userId, film.id, versionIds),
    versionIds.length > 0
      ? prisma.watchProgress.findMany({
          where: { userId: gate.userId, versionId: { in: versionIds } },
          select: { versionId: true, positionSecs: true, completed: true },
        })
      : Promise.resolve([]),
  ]);

  const versions: FilmVersionV1[] = film.versions.map((v) => ({ ...v, playable: v.jellyfinId !== null }));
  const progress: VersionProgress[] = progressRows.map((p) => ({
    // versionId is non-null by construction (queried `in: versionIds`).
    versionId: p.versionId!,
    positionSecs: p.positionSecs,
    completed: p.completed,
  }));

  const body: FilmDetailResponse = { ...film, versions, favourite: userState.favourite, progress };
  return NextResponse.json(body);
}
