"use server";

// Self-service account actions: rename yourself, delete your own account.
// Separate from household.ts (which is about managing a household you're
// staying in) — this is the caller acting on their own User row. Ported
// from the template app's app/actions/account.ts, restyled to MediaVault's
// own auth/db modules and no per-household currency concept.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { isTooLong } from "@/lib/validation";

export type ActionState = { error?: string } | null;

/** Rename yourself — the display name shown in the nav and to other
 *  household members. Distinct from updateHouseholdName
 *  (app/actions/household.ts), which renames the household itself. Not a
 *  BetterAuth field update (no update-user endpoint fits an OTP-only,
 *  password-less app cleanly), so this is a plain Prisma update guarded by
 *  nothing but "you can only rename your own session's user". */
export async function updateName(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Enter a name." };
  if (isTooLong(name, 256)) return { error: "That name is a bit long." };

  await prisma.user.update({ where: { id: session.user.id }, data: { name } });
  await logAudit({ userId: session.user.id, action: "user.rename" });

  revalidatePath("/", "layout");
  return null;
}

/** Permanently delete the signed-in user's own account.
 *
 *  A plain member (or an owner with a co-owner already in place) can
 *  always delete their account outright — prisma/schema.prisma's cascades
 *  take their Session, Account, Member, and any Invitations they sent
 *  along with them; the household itself is untouched, exactly like
 *  removeMember.
 *
 *  An owner with no co-owner is different: this app has no "ownerless
 *  household" state, so there's nowhere for the household to go. That path
 *  requires typing the household's exact name to confirm — deleting your
 *  account there deletes the whole household for everyone in it.
 *
 *  Bypasses BetterAuth's own /delete-user endpoint (same reasoning as
 *  acceptInvitation bypassing /organization/accept-invitation): that
 *  endpoint assumes a password-based flow (requires either a password or a
 *  "fresh" session before it'll proceed), which doesn't fit an OTP-only
 *  app with no password to check. */
export async function deleteAccount(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin");
  const userId = session.user.id;

  const member = await prisma.member.findFirst({ where: { userId } });

  if (member?.role === "owner") {
    const otherOwners = await prisma.member.count({
      where: { householdId: member.householdId, role: "owner", userId: { not: userId } },
    });

    if (otherOwners === 0) {
      const household = await prisma.household.findUniqueOrThrow({
        where: { id: member.householdId },
      });
      const confirmName = String(formData.get("confirmHouseholdName") ?? "").trim();
      if (confirmName !== household.name) {
        return {
          error: `You're the only owner of "${household.name}" — deleting your account deletes the whole household. Type its name exactly to confirm, or promote another member to owner first and come back.`,
        };
      }

      // No child tables to clear first — deleting the household cascades
      // to Member/Invitation via the schema's own onDelete: Cascade.
      await prisma.household.delete({ where: { id: household.id } });
    }
  }

  // Sign out first, while the Session row this cookie points at still
  // exists — auth.api.signOut() clears the cookie via the response
  // headers correctly. Deleting the User row after cascades the Session
  // away too, but that's just a second, redundant removal by then.
  await auth.api.signOut({ headers: await headers() });
  await prisma.user.delete({ where: { id: userId } });
  // Deliberately after the delete: the row records that this user id
  // erased itself (and possibly its household) even though the user is
  // gone — the admin page renders the missing name as "(deleted)".
  await logAudit({ userId, householdId: member?.householdId, action: "account.delete" });
  redirect("/signin?deleted=1");
}
