import Link from "next/link";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { requestOTP } from "@/app/actions/auth-flow";
import { safeCallbackURL } from "@/lib/safe-callback";
import { OTP_EMAIL_COOKIE } from "@/lib/flow-cookies";
import { OTPForm } from "@/components/auth/OTPForm";
import { SubmitButton } from "./submit-button";

// Email-OTP only sign-in (see auth.ts / HOUSEHOLDS_PLAN.md). Two steps on
// this one page: ask for an email, then type the code it received. The
// in-between email rides in an httpOnly cookie (set by requestOTP), not a
// query param. Ported from jinglejotter.com's app/signin/page.tsx, restyled
// to MediaVault's dark, poster-forward palette instead of that app's
// cream/berry Christmas chrome.

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; otp?: string; callbackURL?: string }>;
}) {
  const { error, otp, callbackURL: callbackURLRaw } = await searchParams;
  const callbackURL = safeCallbackURL(callbackURLRaw);

  // Real (database-validated) session check — a genuinely signed-in user
  // skips the sign-in page. Deliberately NOT done in proxy.ts: its
  // cookie-presence check can't tell a stale/foreign cookie from a live
  // session and would redirect-loop.
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) redirect(callbackURL);

  // Step 2 needs the flow cookie; without it (expired, cleared) fall back
  // to step 1 regardless of the query param.
  const otpEmail = otp ? (await cookies()).get(OTP_EMAIL_COOKIE)?.value : undefined;

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-border bg-bg-elevated p-8 text-center shadow-lg shadow-black/30">
        <h1 className="font-display text-3xl tracking-wide text-text">Sign in</h1>

        {error === "MissingEmail" ? (
          <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
            Enter an email address first.
          </p>
        ) : error === "SendFailed" ? (
          <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
            Couldn&apos;t send your code — try again in a moment.
          </p>
        ) : error ? (
          <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
            Sign-in hit a snag ({error}) — try again in a moment.
          </p>
        ) : null}

        {otpEmail ? (
          <>
            <p className="text-sm text-text-muted">
              We emailed a six-digit code to{" "}
              <span className="font-semibold text-text">{otpEmail}</span>. It expires in 10
              minutes.
            </p>
            <OTPForm callbackURL={callbackURL} />
            <div className="flex items-center gap-4 text-xs text-text-faint">
              <form action={requestOTP}>
                <input type="hidden" name="email" value={otpEmail} />
                <input type="hidden" name="callbackURL" value={callbackURL} />
                <button type="submit" className="underline-offset-2 hover:text-text-muted hover:underline">
                  Resend the code
                </button>
              </form>
              <Link
                href={`/signin?callbackURL=${encodeURIComponent(callbackURL)}`}
                className="underline-offset-2 hover:text-text-muted hover:underline"
              >
                Use a different email
              </Link>
            </div>
          </>
        ) : (
          <>
            <form action={requestOTP} className="flex w-full flex-col gap-3">
              <input type="hidden" name="callbackURL" value={callbackURL} />
              <input
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                className="w-full rounded-md border border-border bg-bg-elevated-2 px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
              />
              {/* Only used if this email has no account yet (an invitee's
                  first sign-in) — an existing user's name is never touched. */}
              <input
                type="text"
                name="name"
                maxLength={256}
                placeholder="Your name (new accounts only)"
                className="w-full rounded-md border border-border bg-bg-elevated-2 px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
              />
              <SubmitButton pendingText="Sending…">Email me a sign-in code</SubmitButton>
            </form>
            <p className="text-xs text-text-faint">
              New here with an access code?{" "}
              <Link href="/signup" className="font-semibold text-accent underline-offset-2 hover:underline">
                Set up your account
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
