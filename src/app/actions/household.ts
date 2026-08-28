"use server";

// Server actions for households: onboarding (create one, or jump to an
// invite), membership (inviting people in, cancelling pending invites), and
// redeeming an invite. Ported from jinglejotter.com's app/actions/household.ts,
// simplified for MediaVault (see HOUSEHOLDS_PLAN.md Phase 4):
//   - createHousehold has no per-household seed data to create (no
//     "season"/"category" concept here) — just claim the code and call
//     auth.api.createOrganization, no extra transaction for seeding, and no
//     accessKind/accessGrantedAt/accessCodeId columns to stamp (MediaVault's
//     Household model doesn't carry them — see prisma/schema.prisma).
//   - createInvitation only has the household-invite branch; jinglejotter's
//     "appOnly" (no-household, come-try-the-app) branch is a growth-marketing
//     concept that doesn't apply here.
//   - updateHouseholdName/updateHouseholdCurrency/promoteToOwner/
//     demoteToMember/removeMember are out of scope for this phase.
//   - No logAudit — this codebase has no audit-log concept yet (see
//     HOUSEHOLDS_PLAN.md); not invented here.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { SIGNUP_CODE_COOKIE } from "@/lib/flow-cookies";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireMember } from "@/lib/require-member";
import { slugify } from "@/lib/slug";
import { isTooLong } from "@/lib/validation";
import { claimAccessCode, releaseClaim } from "@/lib/access";

// `sent` is unused today (the app-only invite branch that produced it isn't
// ported), kept only so the shared ActionState shape stays a superset of
// what any action here returns.
export type ActionState = { error?: string; sent?: string } | null;

/** First-run: create a brand-new household for the signed-in user, who
 *  becomes its owner. Delegates to BetterAuth's create-organization
 *  endpoint, which enforces the same single-household-per-user check as
 *  invite acceptance (auth.ts's organizationLimit) and assigns creatorRole
 *  ("owner"). */
export async function createHousehold(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin?callbackURL=/onboarding");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Give your household a name." };
  if (isTooLong(name, 60)) return { error: "That name is a bit long." };

  // Claim the access code FIRST (atomic — see lib/access.ts), so a raced
  // last slot of a shared code fails cleanly here rather than after an
  // organization already exists. The failure path below compensates.
  const claim = await claimAccessCode(String(formData.get("code") ?? ""), session.user.email);
  if (!claim.ok) return { error: claim.error };

  try {
    await auth.api.createOrganization({
      headers: await headers(),
      body: { name, slug: slugify(name) },
    });
  } catch (err) {
    await releaseClaim(claim.codeId);
    return { error: err instanceof Error ? err.message : "Couldn't create that household." };
  }

  // The /signup flow's carried code (pre-filled above the fold on
  // /onboarding) is spent now — drop it so it can't leak into a later
  // onboarding render for anyone else on this browser.
  (await cookies()).delete(SIGNUP_CODE_COOKIE);

  // The nav reads session/membership state on every render (sign-out
  // control, future membership-aware chrome) — without this it can keep
  // serving a stale pre-household render on a same-tree client transition
  // like this redirect.
  revalidatePath("/", "layout");
  redirect("/");
}

/** First-run: jump straight to an invite's landing page from a pasted link
 *  or bare token, rather than making someone paste just the id. */
export async function goToInvite(formData: FormData): Promise<void> {
  const raw = String(formData.get("invite") ?? "").trim();
  if (!raw) redirect("/onboarding");

  const marker = "/invite/";
  const markerIndex = raw.indexOf(marker);
  const token = markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : raw;
  const cleanToken = token.split(/[?#]/)[0].trim();

  redirect(`/invite/${encodeURIComponent(cleanToken)}`);
}

/** Invite someone into the household by email. Delegates to BetterAuth's own
 *  create-invitation endpoint, which checks the caller actually holds
 *  invitation:create permission (owner-only by default — see auth.ts) and
 *  enforces the household's membership limit. The email is a hint shown in
 *  the invite UI, not an authorization check — see acceptInvitation, which
 *  redeems by bearer token, not by matching this address. */
export async function createInvitation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { householdId } = await requireMember();

  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Enter an email address." };
  if (isTooLong(email)) return { error: "That email address is too long." };

  try {
    await auth.api.createInvitation({
      headers: await headers(),
      body: { organizationId: householdId, email, role: "member" },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't send that invite." };
  }

  revalidatePath("/household");
  return null;
}

/** Revoke a pending invite. */
export async function cancelInvitation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireMember();

  const invitationId = String(formData.get("invitationId") ?? "").trim();
  if (!invitationId) return { error: "Missing invite." };

  try {
    await auth.api.cancelInvitation({
      headers: await headers(),
      body: { invitationId },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't cancel that invite." };
  }

  revalidatePath("/household");
  return null;
}

/** Redeem an invite by token — the invitation's own id doubles as the
 *  bearer token (see prisma/schema.prisma; there's no separate token
 *  column). Deliberately bypasses BetterAuth's own acceptInvitation
 *  endpoint, which requires the invitee's email to match the invitation's —
 *  this app's invites are redeemed by token alone (modelled on how
 *  Tailscale invite links work: whoever holds the link can redeem it).
 *  Single-household-per-user is enforced here, not by the plugin (which
 *  allows multi-org membership by default). Every path either redirects to
 *  /invite/[token] with an error code or, on success, to the dashboard —
 *  there's no inline error state to return. */
export async function acceptInvitation(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect("/");

  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) redirect(`/signin?callbackURL=${encodeURIComponent(`/invite/${token}`)}`);

  const invitation = await prisma.invitation.findUnique({ where: { id: token } });
  if (!invitation || invitation.status !== "pending" || invitation.expiresAt < new Date()) {
    redirect(`/invite/${token}?error=invalid`);
  }

  const existingMembership = await prisma.member.findFirst({ where: { userId } });
  if (existingMembership) {
    redirect(
      `/invite/${token}?error=${
        existingMembership.householdId === invitation.householdId
          ? "already-member"
          : "already-in-household"
      }`,
    );
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        // Re-checked inside a Serializable transaction: Member.userId has no
        // unique constraint, so two concurrent accepts (tokens for two
        // different households) would otherwise both pass the check above
        // and leave the user with two memberships — breaking requireMember's
        // at-most-one-row assumption. Serializable makes the loser abort.
        //
        // SQLite verification (HOUSEHOLDS_PLAN.md flagged this as unverified
        // for this app's better-sqlite3 provider, since jinglejotter.com
        // runs Postgres): checked directly against
        // @prisma/adapter-better-sqlite3's startTransaction() — it accepts
        // "SERIALIZABLE" (throwing DriverAdapterError("InvalidIsolationLevel")
        // for any other explicit level) and, regardless of the level
        // requested, always acquires an internal mutex around the whole
        // transaction before issuing BEGIN — i.e. every transaction on this
        // adapter already runs one-at-a-time, so requesting Serializable
        // here is accepted and gives genuine (in fact stronger-than-typical)
        // isolation rather than erroring or silently downgrading.
        const racedMembership = await tx.member.findFirst({ where: { userId } });
        if (racedMembership) throw new Error("already-in-household");
        // Unlike jinglejotter.com's schema, MediaVault's Member model (see
        // prisma/schema.prisma) has no @default on id/createdAt — BetterAuth's
        // own create-organization/accept-invitation endpoints always supply
        // both at the adapter level regardless, so it never mattered there;
        // this is the one path that creates a Member row via raw Prisma
        // instead (deliberately bypassing BetterAuth's own endpoint — see
        // this function's doc comment), so it must supply them itself.
        await tx.member.create({
          data: {
            id: randomUUID(),
            householdId: invitation.householdId,
            userId,
            role: invitation.role ?? "member",
            createdAt: new Date(),
          },
        });
        await tx.invitation.update({ where: { id: invitation.id }, data: { status: "accepted" } });
      },
      { isolationLevel: "Serializable" },
    );
  } catch {
    redirect(`/invite/${token}?error=already-in-household`);
  }

  // See the matching comment in createHousehold — same stale-nav problem,
  // same fix.
  revalidatePath("/", "layout");
  redirect("/");
}
