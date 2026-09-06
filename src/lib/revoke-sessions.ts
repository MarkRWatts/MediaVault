// Session revocation when trust is withdrawn.
//
// The web-of-trust check (src/lib/allowed-email.ts) runs only when a
// session is CREATED (auth.ts's databaseHooks.session.create.before). On
// its own, that meant removing someone from a household, cancelling their
// invitation or revoking their access code changed nothing for a session
// they already held — with the default 7-day lifetime and a sliding 1-day
// refresh, a removed member who kept visiting never lost access. Every
// trust-withdrawing action now calls one of these so the change takes
// effect on their very next request.

import { prisma } from "@/lib/db";
import { isAllowedEmail } from "@/lib/allowed-email";

/** End every session a user holds. Unconditional — used when someone is
 *  removed from a household: whatever else might still vouch for them, they
 *  have to sign in again, and the session-create hook decides afresh. */
export async function revokeSessionsForUser(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/** End the sessions of every member of a household — for the sole-owner
 *  account-deletion path, which deletes the household out from under them. */
export async function revokeSessionsForHousehold(householdId: string): Promise<number> {
  const members = await prisma.member.findMany({ where: { householdId }, select: { userId: true } });
  if (members.length === 0) return 0;
  const { count } = await prisma.session.deleteMany({
    where: { userId: { in: members.map((m) => m.userId) } },
  });
  return count;
}

/** After an invitation or email-bound access code is withdrawn: if nothing
 *  else vouches for that address any more (isAllowedEmail re-evaluated
 *  against the post-change state), end the sessions of any user holding it.
 *  A user who is also a member, root-listed, or covered by another live
 *  invite/code keeps their sessions. User.email is stored as typed, so the
 *  match is done case-insensitively in JS after a fetch, same as
 *  allowed-email.ts. */
export async function revokeSessionsIfNoLongerVouched(email: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;
  if (await isAllowedEmail(normalized)) return 0;

  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const ids = users.filter((u) => u.email.trim().toLowerCase() === normalized).map((u) => u.id);
  if (ids.length === 0) return 0;
  const { count } = await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  return count;
}
