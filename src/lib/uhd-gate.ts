// The server-enforced half of the UltraHD rule, in the same posture as the
// age gate next door (src/lib/age-gate.ts): something the playback routes
// call, not something a client can decline to apply. A UHD Version plays
// only as the file itself (direct play) — the rule and its reasoning live on
// uhdPlaybackBlocked in src/lib/constants.ts — so this refuses the routes
// that would convert one. Disabling a button is a courtesy, not a boundary — the iOS
// and tvOS clients hit these routes by id with catalogues they cached.
//
// Unlike the age gate this answers 403, not 404. Hiding a UHD version would
// be dishonest: the film, its page and the version's specs are all visible,
// and a native client needs a status it can show a message for rather than a
// 200 it would try to play.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { UHD_BLOCKED_ERROR, uhdPlaybackBlocked } from "@/lib/constants";
import type { MediaKind } from "@/lib/playback/types";

/** Whether `id` names a UHD film Version. Episodes never do: their id is an
 *  EpisodeFile, and a coincidental match with a Version id is no reason. */
export async function isUhdVersion(kind: MediaKind, id: number): Promise<boolean> {
  if (kind !== "film" || !Number.isInteger(id)) return false;
  const version = await prisma.version.findUnique({ where: { id }, select: { format: true } });
  return version !== null && uhdPlaybackBlocked(version);
}

/** The refusal a conversion route answers a UHD Version with. */
export function uhdRefusal(): NextResponse {
  return NextResponse.json({ error: UHD_BLOCKED_ERROR }, { status: 403 });
}

/** The line every route that would *convert* a film adds after its age
 *  gate — HLS segments, prepare, an engine or Jellyfin session: a response
 *  to return as-is, or null to carry on. The routes that serve or account
 *  for the file itself (/stream, progress, status, leave) don't call it —
 *  a UHD Version plays that way (UHD_PLAYBACK_ENABLED's successor note in
 *  src/lib/constants.ts).
 *
 *      const uhd = await uhdGate("film", versionId);
 *      if (uhd) return uhd;
 */
export async function uhdGate(kind: MediaKind, id: number): Promise<NextResponse | null> {
  return (await isUhdVersion(kind, id)) ? uhdRefusal() : null;
}
