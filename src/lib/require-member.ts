import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Ported from jinglejotter.com's lib/require-member.ts. MediaVault has no
// per-household currency concept (that app's money-tracking feature doesn't
// apply here), so that field is dropped entirely — otherwise same shape.
export type Member = { userId: string; householdId: string; role: string };

/** Every server action's first call: resolves the signed-in user's
 *  household membership from the session. Single membership is enforced at
 *  create/accept-invite time (see auth.ts's organizationLimit and
 *  acceptInvitation), so this can safely assume at most one row. Throws —
 *  appropriate for a server action, where the caller turns a thrown Error
 *  into a form error. For page data-loading use requireMemberOrRedirect()
 *  instead. */
export async function requireMember(): Promise<Member> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not signed in");

  const member = await prisma.member.findFirst({ where: { userId } });
  if (!member) throw new Error("You're not part of a household yet.");

  return { userId, householdId: member.householdId, role: member.role };
}

/** Page-load variant of requireMember(): redirects instead of throwing,
 *  matching the redirect-based auth pattern this app's pages already use.
 *  Not signed in -> /signin; signed in but no household yet -> /onboarding
 *  (create-a-household or jump-to-an-invite, not a dead end). */
export async function requireMemberOrRedirect(): Promise<Member> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const member = await prisma.member.findFirst({ where: { userId } });
  if (!member) redirect("/onboarding");

  return { userId, householdId: member.householdId, role: member.role };
}

/** Route-handler variant: gates an owner-only API route. Route handlers
 *  can't throw-to-error-page or redirect the way a server action/page can —
 *  the caller needs a Response it can `return` immediately — so this
 *  returns either the resolved Member or a NextResponse the caller should
 *  return as-is. Mirrors the { error } JSON shape every other route in this
 *  app already uses (see e.g. api/video/[versionId]/stream/route.ts):
 *  401 when there's no session at all, 403 when there's a session but no
 *  household membership or the membership isn't "owner". */
export async function requireOwnerOrResponse(): Promise<Member | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const member = await prisma.member.findFirst({ where: { userId } });
  if (!member) {
    return NextResponse.json({ error: "You're not part of a household yet." }, { status: 403 });
  }
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owner-only action" }, { status: 403 });
  }

  return { userId, householdId: member.householdId, role: member.role };
}
