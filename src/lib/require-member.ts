import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

// App-owner gating (media scan/enrich/report, /admin). Deliberately
// separate from ALLOWED_EMAILS (the sign-in web-of-trust root) and from
// Member.role's per-household "owner": User.isAppOwner is app-wide,
// normally true for exactly one user (the product owner), and does NOT
// change if household-level promotion is ever added — a member promoted to
// "owner" of their own household must not gain scan/enrich/report access.
// See prisma/schema.prisma's User.isAppOwner comment.
export type Owner = { userId: string; email: string };

async function currentOwner(): Promise<Owner | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAppOwner: true, email: true },
  });
  if (!user?.isAppOwner) return null;
  return { userId, email: user.email };
}

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

/** Route-handler variant: gates an owner-only API route (media
 *  scan/enrich/report/admin). Route handlers can't throw-to-error-page or
 *  redirect the way a server action/page can — the caller needs a Response
 *  it can `return` immediately — so this returns either the resolved Owner
 *  or a NextResponse the caller should return as-is. Mirrors the { error }
 *  JSON shape every other route in this app already uses (see e.g.
 *  api/video/[versionId]/stream/route.ts): 401 when there's no session at
 *  all, 403 when there's a session but the user isn't the app owner.
 *
 *  Checks User.isAppOwner, NOT Member.role — see the Owner type's doc
 *  comment above. This function's name and return/response shape are
 *  unchanged from before that switch (18+ routes already call it this
 *  way); only what it checks internally moved from a per-household role to
 *  an app-wide flag. */
export async function requireOwnerOrResponse(): Promise<Owner | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const owner = await currentOwner();
  if (!owner) {
    return NextResponse.json({ error: "Owner-only action" }, { status: 403 });
  }

  return owner;
}

/** Page-load variant: gates an owner-only page (/scan, /report, /admin).
 *  Not signed in -> /signin; signed in but not the app owner -> / (the
 *  page simply doesn't exist for them, same posture as
 *  requireMemberOrRedirect's redirect targets). */
export async function requireOwnerOrRedirect(): Promise<Owner> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin");

  const owner = await currentOwner();
  if (!owner) redirect("/");
  return owner;
}

/** Server-action variant: throws for non-owners (the caller's form
 *  surfaces it as an error), mirroring requireMember()'s throw-vs-redirect
 *  split. Used by the admin actions (mint/send/revoke access codes). */
export async function requireOwner(): Promise<Owner> {
  const owner = await currentOwner();
  if (!owner) throw new Error("Only the app owner can do that.");
  return owner;
}
