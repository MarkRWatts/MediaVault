// BetterAuth config — Phase 3 of HOUSEHOLDS_PLAN.md adds the organization
// plugin (renamed to Household/Member/Invitation), the emailOTP plugin (the
// only credential this app supports), and the web-of-trust gate that
// refuses a session for anyone not vouched for by ALLOWED_EMAILS, an
// existing household membership, a pending invitation, or a live access
// code. See HOUSEHOLDS_PLAN.md "Access codes & the web of trust" for the
// full design — ported from jinglejotter.com's auth.ts.
import { betterAuth } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { isAllowedEmail } from "@/lib/allowed-email";
import { sendSignInOTP } from "@/lib/otp-email";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  databaseHooks: {
    // Gate every session creation (i.e. every successful sign-in), not just
    // first-time account creation — this is the authoritative check. A
    // stranger can still end up with a bare, unusable User row (BetterAuth
    // creates it before this hook runs), but isAllowedEmail deliberately
    // never treats a bare User row as vouching for itself.
    session: {
      create: {
        async before(session) {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });
          if (!(await isAllowedEmail(user?.email))) {
            return false;
          }
          return true;
        },
      },
    },
  },
  plugins: [
    // Households — renamed to match the app's own domain language; the
    // plugin's underlying behaviour (roles, endpoints) is unchanged.
    organization({
      schema: {
        organization: { modelName: "Household" },
        member: {
          modelName: "Member",
          fields: { organizationId: "householdId" },
        },
        invitation: {
          modelName: "Invitation",
          fields: { organizationId: "householdId" },
        },
        session: {
          fields: { activeOrganizationId: "activeHouseholdId" },
        },
      },
      creatorRole: "owner",
      // One household per user (not the plugin's default multi-org model).
      // organizationLimit only guards the *create* path — the accept-invite
      // path (Phase 4) needs its own "already a member elsewhere" check in
      // a custom token-only accept route, same as jinglejotter.com.
      organizationLimit: async (user) => {
        const existingMembership = await prisma.member.findFirst({
          where: { userId: user.id },
        });
        return existingMembership !== null;
      },
      // A household's library access is the whole point — never let the
      // plugin's built-in delete-organization endpoint remove one outright.
      disableOrganizationDeletion: true,
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 10, // 10 minutes
      allowedAttempts: 3,
      // Sign-up-via-OTP is allowed: the web of trust is enforced twice
      // independently — sendSignInOTP silently refuses to email a stranger
      // at all, and databaseHooks.session.create.before above refuses the
      // session on every sign-in regardless of method. So a disallowed
      // email can never get a session even with sign-up enabled here; at
      // worst a refused sign-in leaves an unusable orphan User row, which
      // allowed-email.ts deliberately does NOT count as vouching. This is
      // also how invitees get their accounts: a pending invitation vouches
      // for their email, so plain sign-in works for them with no access
      // code involved.
      disableSignUp: false,
      sendVerificationOTP: sendSignInOTP,
    }),
    // Required for the server-action sign-in/sign-out pattern Phase 4's
    // pages will use — without this, Set-Cookie headers from actions
    // invoked via `auth.api.*` inside a "use server" action don't reach the
    // browser. Must stay last in this array.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
