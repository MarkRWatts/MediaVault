"use server";

// The email-OTP sign-in/sign-up flow — ported essentially as-is from
// jinglejotter.com's app/actions/auth-flow.ts (auth-mechanism code, not
// app-domain-specific). Three steps across two pages:
//
//   /signin step 1: requestOTP — email (+ optional name for new accounts)
//   /signup step 1: beginSignup — name + email + access code (the trust
//                   boundary for brand-new households; invitees don't need
//                   it and just use /signin, vouched by their invitation)
//   step 2 (both):  verifyOTP — the emailed code, typed in place
//
// The in-between state (which email, their name, their access code) rides
// in short-lived httpOnly cookies rather than query params, so no PII ever
// lands in a URL. The access code survives verification so /onboarding can
// pre-fill it — entered once, used twice (sign-up trust + household claim).

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeCode } from "@/lib/access";
import { safeCallbackURL } from "@/lib/safe-callback";
import { isTooLong } from "@/lib/validation";
import {
  OTP_EMAIL_COOKIE,
  OTP_NAME_COOKIE,
  PASSKEY_NUDGE_COOKIE,
  SIGNUP_CODE_COOKIE,
} from "@/lib/flow-cookies";

export type ActionState = { error?: string } | null;

/** beginSignup echoes the typed values back on failure — React 19 resets
 *  uncontrolled form fields after an action, and a validation error must
 *  not cost someone their three typed fields. */
export type SignupState = {
  error?: string;
  values?: { name: string; email: string; code: string };
} | null;

const FLOW_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 10, // matches the OTP's own expiry
} as const;

// One message for every way a signup code can be wrong (unknown, expired,
// exhausted, bound to a different email): distinguishing them would tell a
// guesser which codes exist and whose they are.
const SIGNUP_CODE_FAILED =
  "That code isn't valid for this email — check both for typos, or ask whoever sent it for a fresh one.";

/** /signin step 1 (also the step-2 "resend" button). Always lands on the
 *  enter-the-code step whether or not an email was actually sent — the
 *  web-of-trust gate inside lib/otp-email.ts silently skips strangers, and
 *  reflecting that here would let anyone probe which emails this app
 *  knows. */
export async function requestOTP(formData: FormData): Promise<void> {
  // /signup's resend button sets flow=signup so it lands back on /signup;
  // an unexpected value falls through to /signin (never a redirect target
  // an attacker controls).
  const page = formData.get("flow") === "signup" ? "/signup" : "/signin";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim().slice(0, 256);
  const callbackURL = safeCallbackURL(String(formData.get("callbackURL") ?? ""));
  // Present only for a Jellyfin-SSO-style sign-in (see /signin's own
  // comment) — must ride every redirect this action makes back to /signin,
  // or the OAuth flow silently drops back to a plain callbackURL sign-in.
  const oauthQuery = String(formData.get("oauthQuery") ?? "");
  const params = `&callbackURL=${encodeURIComponent(callbackURL)}${oauthQuery ? `&oauthQuery=${encodeURIComponent(oauthQuery)}` : ""}`;
  if (!email) redirect(`${page}?error=MissingEmail${params}`);

  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: await headers(),
    });
  } catch {
    redirect(`${page}?error=SendFailed${params}`);
  }

  const store = await cookies();
  store.set(OTP_EMAIL_COOKIE, email, FLOW_COOKIE_OPTS);
  if (name) store.set(OTP_NAME_COOKIE, name, FLOW_COOKIE_OPTS);
  else store.delete(OTP_NAME_COOKIE);
  redirect(`${page}?otp=1${params}`);
}

/** /signup step 1: the three-field front door for someone holding a minted
 *  access code. The code must be email-bound AND match the email they're
 *  signing up with — a forwarded code is useless (same rule redemption
 *  enforces, checked here early so the error arrives before any OTP). The
 *  code is NOT claimed yet; that stays atomic inside createHousehold. */
export async function beginSignup(
  _prevState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const codeRaw = String(formData.get("code") ?? "");
  const values = { name, email, code: codeRaw.trim() };

  if (!name) return { error: "Tell us your name.", values };
  if (isTooLong(name, 256)) return { error: "That name is a bit long.", values };
  if (!email || !email.includes("@")) {
    return { error: "That email address doesn't look right.", values };
  }
  if (isTooLong(email)) return { error: "That email address is too long.", values };

  const code = normalizeCode(codeRaw);
  if (!code) return { error: "Enter your access code.", values };
  const row = await prisma.accessCode.findUnique({ where: { code } });
  const live =
    row &&
    row.redeemedCount < row.maxRedemptions &&
    (!row.redeemableUntil || row.redeemableUntil > new Date());
  if (!live || row.email !== email) return { error: SIGNUP_CODE_FAILED, values };

  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: await headers(),
    });
  } catch {
    return { error: "Couldn't send your code email — try again in a moment.", values };
  }

  const store = await cookies();
  store.set(OTP_EMAIL_COOKIE, email, FLOW_COOKIE_OPTS);
  store.set(OTP_NAME_COOKIE, name, FLOW_COOKIE_OPTS);
  // Longer-lived than the flow cookies: it has to survive into /onboarding,
  // where createHousehold claims it and clears this cookie.
  store.set(SIGNUP_CODE_COOKIE, code, { ...FLOW_COOKIE_OPTS, maxAge: 60 * 30 });
  redirect("/signup?otp=1");
}

/** Step 2 for both pages: the emailed six digits. On success the session
 *  cookie is set by BetterAuth (nextCookies plugin) and signup flows land
 *  on /onboarding with their access code carried along. */
export async function verifyOTP(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const store = await cookies();
  const email = store.get(OTP_EMAIL_COOKIE)?.value;
  // Flow state expired (10 min) or cookies cleared — start over.
  if (!email) redirect("/signin");

  const otp = String(formData.get("otp") ?? "").trim();
  if (!otp) return { error: "Enter the code from your email." };
  const name = store.get(OTP_NAME_COOKIE)?.value;
  // Present only when /signin was reached via BetterAuth's oauthProvider
  // `loginPage` (a Jellyfin SSO sign-in, say) — see HOUSEHOLDS_PLAN.md
  // "Jellyfin SSO".
  const oauthQuery = String(formData.get("oauthQuery") ?? "") || undefined;

  let result: unknown;
  if (oauthQuery) {
    // oauthProvider's session-creation hook (the thing that turns
    // oauth_query into a redirect back to the client) only runs for a
    // request that actually goes through BetterAuth's HTTP handler —
    // auth.api.signInEmailOTP() below calls the endpoint directly and
    // silently skips it. So this one path goes over real HTTP instead,
    // and forwards the response's Set-Cookie itself (nextCookies() only
    // forwards cookies from the internal-call path, not this one) using
    // the same parseSetCookieHeader/toCookieOptions it uses internally.
    //
    // Hits the app's own internal port, NOT process.env.BETTER_AUTH_URL —
    // a container calling back into its own public HTTPS domain can't
    // reach itself (hairpin NAT through the VM's edge proxy), which
    // silently timed out here and got reported as "code didn't match" in
    // production. BetterAuth still generates https://…/api/auth URLs
    // regardless, since auth.ts configures baseURL explicitly rather than
    // deriving it from this request's Host header.
    const reqHeaders = await headers();
    let res: Response;
    try {
      res = await fetch(`http://localhost:3000/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "user-agent": reqHeaders.get("user-agent") ?? "",
        },
        body: JSON.stringify({ email, otp, name: name || undefined, oauth_query: oauthQuery }),
      });
    } catch {
      return { error: "That code didn't match — try again, or request a fresh one." };
    }
    if (!res.ok) return { error: "That code didn't match — try again, or request a fresh one." };

    const setCookie = res.headers.getSetCookie?.().join(", ") ?? res.headers.get("set-cookie") ?? "";
    const cookieStore = await cookies();
    parseSetCookieHeader(setCookie).forEach((value, name) => {
      if (!name) return;
      cookieStore.set(name, value.value, toCookieOptions(value));
    });
    result = await res.json();
  } else {
    try {
      result = await auth.api.signInEmailOTP({
        // name only applies when this email has no account yet — an
        // existing user's name is never touched by it.
        body: { email, otp, name: name || undefined },
        headers: await headers(),
      });
    } catch {
      // Wrong, expired, too many attempts, or (for a stranger who was
      // never actually emailed) no OTP at all — one message covers them
      // all.
      return { error: "That code didn't match — try again, or request a fresh one." };
    }
  }

  store.delete(OTP_EMAIL_COOKIE);
  store.delete(OTP_NAME_COOKIE);

  // oauthProvider's session-creation hook replaces the normal response with
  // a redirect (to the consent page, or straight to the client's
  // redirect_uri) whenever oauth_query was supplied above — follow it
  // instead of this app's own callbackURL/onboarding logic.
  if (
    result &&
    typeof result === "object" &&
    "redirect" in result &&
    result.redirect === true &&
    "url" in result &&
    typeof result.url === "string"
  ) {
    redirect(result.url);
  }

  // An email-code sign-in on this device is the moment to suggest a passkey
  // for it (PASSKEYS_PLAN.md Phase 4): the session is at its freshest, so
  // the plugin's 24h registration window is fully open. Not set on the
  // Jellyfin-SSO path above — that redirects straight back to Jellyfin.
  store.set(PASSKEY_NUDGE_COOKIE, "1", { ...FLOW_COOKIE_OPTS, maxAge: 60 * 60 * 24 });

  const cameFromSignup = Boolean(store.get(SIGNUP_CODE_COOKIE)?.value);
  redirect(
    cameFromSignup ? "/onboarding" : safeCallbackURL(String(formData.get("callbackURL") ?? "")),
  );
}
