// BetterAuth config — Phase 3 of HOUSEHOLDS_PLAN.md adds the organization
// plugin (renamed to Household/Member/Invitation), the emailOTP plugin (the
// only credential this app supports), and the web-of-trust gate that
// refuses a session for anyone not vouched for by ALLOWED_EMAILS, an
// existing household membership, a pending invitation, or a live access
// code. See HOUSEHOLDS_PLAN.md "Access codes & the web of trust" for the
// full design — ported from jinglejotter.com's auth.ts.
import { betterAuth } from "better-auth";
import { emailOTP, jwt, organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { isAllowedEmail } from "@/lib/allowed-email";
import { logAudit } from "@/lib/audit";
import { sendSignInOTP } from "@/lib/otp-email";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  // Always on (the default only enables it when NODE_ENV=production, which
  // a misconfigured deploy could miss). Memory storage is fine: one
  // container. Note this only covers BetterAuth's HTTP handler
  // (/api/auth/*); the app's own sign-in server actions call auth.api.*
  // in-process and are throttled separately — see src/lib/throttle.ts and
  // app/actions/auth-flow.ts.
  rateLimit: {
    enabled: process.env.NODE_ENV !== "test",
  },
  advanced: {
    ipAddress: {
      // Behind Cloudflare Tunnel the client IP is `cf-connecting-ip`, set by
      // the edge and not overridable by the client. The default
      // (`x-forwarded-for` only) fails there: Cloudflare and Caddy both
      // append to that header, and BetterAuth refuses a multi-valued XFF
      // as untrustworthy, so every request collapsed into ONE shared
      // rate-limit bucket — three OTP requests from anyone locked everyone
      // out for a minute. `x-forwarded-for` stays as the fallback for the
      // LAN/Caddy path (single-valued there). Same order as
      // src/lib/client-ip.ts.
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
    },
  },
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
      // Nobody creates a household through the plugin's own endpoint — the
      // access-code claim that gates household creation (the web of trust's
      // growth control, HOUSEHOLDS_PLAN.md) lives in app/actions/household.ts,
      // and the plugin's HTTP /organization/create knew nothing about it.
      // createHousehold now calls auth.api.createOrganization as a *system*
      // action (body.userId, no request headers), which the plugin permits
      // regardless of this setting; src/proxy.ts additionally 404s the
      // whole /api/auth/organization/* surface.
      allowUserToCreateOrganization: () => false,
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
      // Hash the code at rest: the default keeps it in plaintext in the
      // Verification table for its 10-minute life, so a copy of the SQLite
      // file (or a backup) taken in that window is a usable sign-in code.
      storeOTP: "hashed",
      sendVerificationOTP: sendSignInOTP,
    }),
    // Lets Jellyfin's jellyfin-plugin-sso authenticate against this
    // BetterAuth instance as a generic OIDC provider, so household members
    // sign into Jellyfin with their MediaVault account instead of a
    // separate Jellyfin password — see HOUSEHOLDS_PLAN.md "Jellyfin SSO".
    // jwt() is required by oauthProvider() for JWKS/ID-token signing.
    // Jellyfin is registered once as a static, trusted OAuth client via
    // scripts/register-jellyfin-client.ts (skip_consent: true), so
    // /consent is never actually shown for it in practice — it's only
    // wired up because oauthProvider() requires a consentPage regardless.
    jwt(),
    oauthProvider({
      loginPage: "/signin",
      consentPage: "/consent",
      // OAuth client management (create/update/delete/rotate-secret/list)
      // is app-owner only. The plugin's default lets ANY signed-in user
      // register a client: a member could mint one named "Jellyfin" with
      // their own redirect URI and phish other members' ID tokens through
      // /consent. The one legitimate client (Jellyfin's SSO plugin) is
      // registered by the owner from /admin via the server-only admin
      // endpoint, which this hook doesn't gate anyway.
      clientPrivileges: async ({ user }) => {
        if (!user?.id) return false;
        const row = await prisma.user.findUnique({ where: { id: user.id }, select: { isAppOwner: true } });
        return row?.isAppOwner === true;
      },
    }),
    // Passkeys (see PASSKEYS_PLAN.md) — a second credential for EXISTING
    // accounts, never a sign-up path: registration needs a signed-in (and
    // fresh, < session.freshAge) session, and sign-in creates its session
    // through the same internalAdapter.createSession every other method
    // uses, so the web-of-trust hook above gates it with no extra code.
    passkey({
      rpName: "MediaVault",
      // The plugin's default is to trust the request's Origin header as the
      // expected WebAuthn origin; pin it to our own base URL instead. rpID
      // is derived from that URL's hostname by the plugin. Trailing slash
      // stripped defensively — the plugin is explicit that it must not have
      // one, and .env files are hand-edited.
      origin: process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ?? null,
      authenticatorSelection: {
        // Discoverable credentials: sign-in is username-less (the
        // authenticator presents which passkeys it holds for this rpID),
        // which is what makes one-tap sign-in and browser autofill work.
        residentKey: "required",
        userVerification: "preferred",
      },
      registration: {
        // Content-free audit, same vocabulary as the server actions (see
        // src/lib/audit.ts). Server-side so it fires however the
        // registration was driven, not just from /account's UI.
        afterVerification: async ({ user }) => {
          await logAudit({ userId: user.id, action: "passkey.add" });
        },
      },
    }),
    // Required for the server-action sign-in/sign-out pattern Phase 4's
    // pages will use — without this, Set-Cookie headers from actions
    // invoked via `auth.api.*` inside a "use server" action don't reach the
    // browser. Must stay last in this array.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
