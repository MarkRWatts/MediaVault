// POST/GET /api/video/:versionId/progress — resume-position + play-count
// tracking for a signed-in user's own viewing of one film Version (see
// HOUSEHOLDS_PLAN.md's "Watch history & stats", Phase 7).
//
// Unlike the other /api/video/* routes (playback support, open to any
// household member), this one is inherently per-user — there's no useful
// "resume position" without knowing whose it is — so it checks the real
// session itself (auth.api.getSession()) rather than leaning solely on
// proxy.ts's optimistic cookie check. Still no ownership/role gate beyond
// "signed in": any household member watching a shared library title gets
// their own progress row, same posture as playback itself.
//
// GET lives here rather than as an addition to the status route because
// status is deliberately session-agnostic (it just describes prepare/cache
// state for anyone), while progress is unavoidably user-scoped — keeping it
// on its own route means the two response shapes never have to be
// reconciled.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { WATCH_COMPLETED_RATIO } from "@/lib/constants";

async function currentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

function parseVersionId(versionIdParam: string): number | null {
  const versionId = Number(versionIdParam);
  return Number.isInteger(versionId) ? versionId : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = parseVersionId(versionIdParam);
  if (versionId === null) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const row = await prisma.watchProgress.findUnique({
    where: { userId_versionId: { userId, versionId } },
    select: { positionSecs: true, completed: true, playCount: true },
  });

  return NextResponse.json(row ?? { positionSecs: 0, completed: false, playCount: 0 });
}

interface ProgressBody {
  positionSecs: number;
  durationSecs: number;
  // True exactly once per player session — sent on the first progress
  // report after playback actually starts (see VideoPlayer.tsx). Every
  // later report for the same viewing (throttled timeupdate ticks, the
  // pause flush, the on-close flush) omits it, so playCount tracks "how
  // many times this was started", not "how many progress ticks fired".
  isNewPlay?: boolean;
}

export async function POST(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = parseVersionId(versionIdParam);
  if (versionId === null) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let body: Partial<ProgressBody>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { positionSecs, durationSecs, isNewPlay } = body;
  if (typeof positionSecs !== "number" || !Number.isFinite(positionSecs) || positionSecs < 0) {
    return NextResponse.json({ error: "positionSecs must be a non-negative number" }, { status: 400 });
  }
  if (typeof durationSecs !== "number" || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return NextResponse.json({ error: "durationSecs must be a positive number" }, { status: 400 });
  }

  // See WATCH_COMPLETED_RATIO's doc comment for why 95%.
  const completed = positionSecs >= durationSecs * WATCH_COMPLETED_RATIO;

  const row = await prisma.watchProgress.upsert({
    where: { userId_versionId: { userId, versionId } },
    create: {
      userId,
      versionId,
      positionSecs,
      completed,
      // A row not existing yet means this is inherently the first play,
      // regardless of what the client's isNewPlay flag says.
      playCount: 1,
    },
    update: {
      positionSecs,
      completed,
      // A fresh session start increments playCount and un-sticks
      // `completed` from a previous viewing — otherwise re-watching a
      // finished film would still read as complete for the first few
      // seconds of the new play (harmless in practice, since positionSecs
      // is also tiny then, but keeping the two fields consistent is
      // cheap and avoids a confusing intermediate state).
      ...(isNewPlay ? { playCount: { increment: 1 }, completed: false } : {}),
    },
  });

  return NextResponse.json({
    positionSecs: row.positionSecs,
    completed: row.completed,
    playCount: row.playCount,
  });
}
