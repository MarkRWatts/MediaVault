// The sign-in gate: a web of trust rooted at ALLOWED_EMAILS (see
// HOUSEHOLDS_PLAN.md "Access codes & the web of trust"). An email may sign
// in iff something vouches for it:
//
//   1. The env root anchor (ALLOWED_EMAILS). Kept in env on purpose: the web
//      needs a root that no database state can lock out.
//   2. Membership: a User with this email who belongs to a household. NOT
//      "any User row" — BetterAuth creates the User row BEFORE the
//      session-create hook refuses a stranger, so a bare User row can be
//      the residue of a refused sign-in and must never vouch for itself.
//   3. A pending, unexpired household Invitation for this email (owners
//      extending the web; cancelling the invite revokes sign-in again).
//   4. A live access code minted FOR this email (admin extending the web):
//      unredeemed slots remaining and not past its cutoff. Once redeemed,
//      arm 2 takes over, since redeeming creates the membership.
//
// Called from src/lib/otp-email.ts (silently no-ops for strangers, so
// unknown addresses never learn this app exists) and from src/lib/auth.ts's
// databaseHooks.session.create.before hook, which gates every successful
// sign-in, not just first-time account creation.

import { prisma } from "@/lib/db";

function rootEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAllowedEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  if (rootEmails().includes(normalized)) return true;

  // BetterAuth's User.email is stored as typed (not lowercased at write
  // time), and SQLite's default collation is case-sensitive — unlike
  // Postgres's `mode: "insensitive"` filter (not supported by the SQLite
  // provider), so the case-insensitive comparison here is done in JS after
  // a plain fetch. Invitation.email and AccessCode.email are both
  // lowercased at write time (see household invite creation and
  // scripts/gen-access-code.ts), so those two could compare directly, but
  // are normalized the same way for consistency and defense-in-depth.
  const [members, invitations, codes] = await Promise.all([
    prisma.member.findMany({
      select: { id: true, user: { select: { email: true } } },
    }),
    prisma.invitation.findMany({
      where: { status: "pending", expiresAt: { gt: new Date() } },
      select: { id: true, email: true },
    }),
    prisma.accessCode.findMany({
      where: {
        email: { not: null },
        OR: [{ redeemableUntil: null }, { redeemableUntil: { gt: new Date() } }],
      },
      select: { id: true, email: true, redeemedCount: true, maxRedemptions: true },
    }),
  ]);

  const member = members.some((m) => m.user.email.trim().toLowerCase() === normalized);
  const invitation = invitations.some((i) => i.email.trim().toLowerCase() === normalized);
  const code = codes.some(
    (c) => c.email?.trim().toLowerCase() === normalized && c.redeemedCount < c.maxRedemptions,
  );

  return member || invitation || code;
}
