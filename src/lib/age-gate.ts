// The playback half of the age-rating gate (src/lib/age-rating.ts).
//
// Filtering the listings (src/lib/queries.ts) is what a restricted member
// SEES; this is what stops them watching. Without it the whole feature would
// be cosmetic: /api/video/517/stream doesn't go through a listing, and a
// guessed or remembered id — a bookmark from before the restriction was
// applied, a link from another member, a native client that cached the
// catalogue — would still hand over the bytes.
//
// Every /api/video/* and /api/tv-video/* handler calls one of these right
// after its session guard. They are deliberately cheap: an unrestricted
// viewer (everyone without a date of birth, which is the default) costs
// zero queries, so the per-segment hot path is untouched for the normal
// case. A restricted viewer costs one indexed lookup per request — the same
// order as the membership check already sitting above it.
//
// Deliberately free of any import of @/lib/auth: every caller has already
// established who is asking (a Member from requireMemberOrResponse, or a
// userId from its own session lookup), and keeping this module to Prisma
// alone is what lets it be tested without standing up BetterAuth.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ageLimitFor, allowsCertificate, type AgeLimit } from "@/lib/age-rating";
import type { MediaKind } from "@/lib/playback/types";

/** 404, not 403: the listings already make a withheld title indistinguishable
 *  from one that doesn't exist, and the streaming routes must not undo that
 *  by confirming "this id is real, you just can't have it". Matches the
 *  shape every other not-found in these routes returns. */
const NOT_FOUND = () => NextResponse.json({ error: "not found" }, { status: 404 });

/** The age limit for a user id, for the handful of routes that resolve their
 *  own session (the progress routes, jf-routes.ts's currentViewer path)
 *  rather than going through requireMemberOrResponse. */
export async function ageLimitForUser(userId: string): Promise<AgeLimit> {
  const member = await prisma.member.findFirst({ where: { userId }, select: { dateOfBirth: true } });
  return ageLimitFor(member?.dateOfBirth ?? null);
}

/** The certificate rating a film Version, or null when the id is unknown.
 *  A Version has no certificate of its own — the Film it belongs to does. */
async function certificationForVersion(versionId: number): Promise<string | null | undefined> {
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    select: { film: { select: { certification: true } } },
  });
  // undefined = no such version (the caller's own 404 path already covers
  // it); null = a real film with no certificate, which fails the gate.
  return version === null ? undefined : version.film.certification;
}

/** Same for an episode file, via its show. Episodes carry no certificate of
 *  their own (see getShows in queries.ts), so the show's is what rates every
 *  episode beneath it — which is also why a show above the limit takes all
 *  of its episodes with it. */
async function certificationForEpisodeFile(episodeFileId: number): Promise<string | null | undefined> {
  const file = await prisma.episodeFile.findUnique({
    where: { id: episodeFileId },
    select: { episode: { select: { season: { select: { show: { select: { certification: true } } } } } } },
  });
  return file === null ? undefined : file.episode.season.show.certification;
}

/** May `limit` play this thing? Unknown ids answer true — the caller's own
 *  not-found handling owns that case, and answering false here would turn
 *  every mistyped id into a "blocked" that leaks nothing but confuses the
 *  logs. `"scene"` is the Adult media type, which has no per-item
 *  certificate at all and is R18 wholesale: any restricted viewer is
 *  refused outright (requireAdultAccess* in require-member.ts is the
 *  primary boundary; this is the belt to its braces). */
export async function canPlay(limit: AgeLimit, kind: MediaKind, id: number): Promise<boolean> {
  if (limit === "unrestricted") return true;
  if (!Number.isInteger(id)) return true;
  if (kind === "scene") return false;

  const certification =
    kind === "film" ? await certificationForVersion(id) : await certificationForEpisodeFile(id);
  if (certification === undefined) return true;
  return allowsCertificate(limit, certification);
}

/** The one line a playback route adds: a NextResponse to return as-is when
 *  the viewer may not watch this, or null to carry on.
 *
 *      const blocked = await ageGate(gate.ageLimit, "film", versionId);
 *      if (blocked) return blocked;
 */
export async function ageGate(limit: AgeLimit, kind: MediaKind, id: number): Promise<NextResponse | null> {
  return (await canPlay(limit, kind, id)) ? null : NOT_FOUND();
}

/** ageGate for the routes that only know the user id (they resolve their own
 *  session rather than going through requireMemberOrResponse). */
export async function ageGateForUser(userId: string, kind: MediaKind, id: number): Promise<NextResponse | null> {
  return ageGate(await ageLimitForUser(userId), kind, id);
}
