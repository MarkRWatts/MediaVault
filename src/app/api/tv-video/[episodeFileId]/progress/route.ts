// GET/POST /api/tv-video/:episodeFileId/progress — the episode twin of
// /api/video/:versionId/progress: the signed-in person's WatchProgress row
// for one episode file (resume position, completed, play count).

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { WATCH_COMPLETED_RATIO } from "@/lib/constants";

async function currentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

function parseId(param: string): number | null {
  const id = Number(param);
  return Number.isInteger(id) ? id : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ episodeFileId: string }> }) {
  const { episodeFileId: param } = await ctx.params;
  const episodeFileId = parseId(param);
  if (episodeFileId === null) return NextResponse.json({ error: "invalid episode file id" }, { status: 400 });
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const row = await prisma.watchProgress.findUnique({
    where: { userId_episodeFileId: { userId, episodeFileId } },
    select: { positionSecs: true, completed: true, playCount: true },
  });
  return NextResponse.json(row ?? { positionSecs: 0, completed: false, playCount: 0 });
}

export async function POST(req: Request, ctx: { params: Promise<{ episodeFileId: string }> }) {
  const { episodeFileId: param } = await ctx.params;
  const episodeFileId = parseId(param);
  if (episodeFileId === null) return NextResponse.json({ error: "invalid episode file id" }, { status: 400 });
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: { positionSecs?: unknown; durationSecs?: unknown; isNewPlay?: unknown };
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
  const exists = await prisma.episodeFile.findUnique({ where: { id: episodeFileId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  const completed = positionSecs >= durationSecs * WATCH_COMPLETED_RATIO;
  const row = await prisma.watchProgress.upsert({
    where: { userId_episodeFileId: { userId, episodeFileId } },
    create: { userId, episodeFileId, positionSecs, completed, playCount: 1 },
    update: { positionSecs, completed, ...(isNewPlay ? { playCount: { increment: 1 }, completed: false } : {}) },
  });
  return NextResponse.json({ positionSecs: row.positionSecs, completed: row.completed, playCount: row.playCount });
}
