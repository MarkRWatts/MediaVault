// GET /api/v1/films/:id — a film's detail screen: versions with their
// audio tracks, `playable` (isFilePlayable, and not a UHD rip while
// UHD_PLAYBACK_ENABLED is off — has been probed and, for the
// jellyfin engine, matched to a Jellyfin item, see IOS_PLAN.md "Video:
// nothing new" and src/lib/playback/engine-flag.ts), the viewer's favourite
// state, and their saved position on each version (so a resume prompt
// doesn't need a second round trip once a version is picked).

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getFilmDetail } from "@/lib/queries";
import { getFilmUserState } from "@/lib/film-user-state";
import { prisma } from "@/lib/db";
import { isFilePlayable } from "@/lib/playback/engine-flag";
import { UHD_BLOCKED_ERROR, uhdPlaybackBlocked } from "@/lib/constants";
import type { FilmDetailResponse, FilmVersionV1, VersionProgress } from "@/lib/api-v1-types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid film id" }, { status: 400 });
  }

  const film = await getFilmDetail(id, gate.ageLimit);
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

  // A UHD version is never playable however well it probed: the playback
  // routes answer 403 for it (src/lib/uhd-gate.ts). Saying so here saves the
  // app a round trip and gives it something to show instead of a bare
  // greyed-out button.
  const versions: FilmVersionV1[] = film.versions.map((v) =>
    uhdPlaybackBlocked(v)
      ? { ...v, playable: false, unplayableReason: UHD_BLOCKED_ERROR }
      : { ...v, playable: isFilePlayable(v) },
  );
  const progress: VersionProgress[] = progressRows.map((p) => ({
    // versionId is non-null by construction (queried `in: versionIds`).
    versionId: p.versionId!,
    positionSecs: p.positionSecs,
    completed: p.completed,
  }));

  const body: FilmDetailResponse = { ...film, versions, favourite: userState.favourite, progress };
  return NextResponse.json(body);
}
