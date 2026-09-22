// The server-enforced half of the UltraHD block, in the same posture as the
// age gate next door (src/lib/age-gate.ts): something the playback routes
// call, not something a client can decline to apply. The rule itself and the
// reasoning behind it live on UHD_PLAYBACK_ENABLED in src/lib/constants.ts,
// which the UI reads to decide what to offer; this is what stops anyone who
// asks anyway. Disabling a button is a courtesy, not a boundary — the iOS
// and tvOS clients hit these routes by id with catalogues they cached.
//
// Unlike the age gate this answers 403, not 404. Hiding a UHD version would
// be dishonest: the film, its page and the version's specs are all visible,
// and a native client needs a status it can show a message for rather than a
// 200 it would try to play.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { UHD_BLOCKED_ERROR, UHD_PLAYBACK_ENABLED, uhdPlaybackBlocked } from "@/lib/constants";
import type { MediaKind } from "@/lib/playback/types";

/** The line every film playback route adds right after its age gate: a
 *  response to return as-is, or null to carry on.
 *
 *      const uhd = await uhdGate("film", versionId);
 *      if (uhd) return uhd;
 *
 *  Free once the flag is on, and free for episodes either way — only a film
 *  id costs a lookup, and only while playback is switched off.
 */
export async function uhdGate(kind: MediaKind, id: number): Promise<NextResponse | null> {
  if (UHD_PLAYBACK_ENABLED) return null;
  // Only films have a Version with a format; an episode's id names an
  // EpisodeFile, and blocking on a coincidental id match would be a bug.
  if (kind !== "film") return null;
  if (!Number.isInteger(id)) return null;

  const version = await prisma.version.findUnique({
    where: { id },
    select: { format: true },
  });
  // An unknown id is the caller's own not-found to answer, same as canPlay.
  if (!version || !uhdPlaybackBlocked(version)) return null;
  return NextResponse.json({ error: UHD_BLOCKED_ERROR }, { status: 403 });
}
