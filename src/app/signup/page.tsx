import Link from "next/link";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OTP_EMAIL_COOKIE } from "@/lib/flow-cookies";
import { requestOTP } from "@/app/actions/auth-flow";
import { SignupForm } from "@/components/auth/SignupForm";
import { OTPForm } from "@/components/auth/OTPForm";

// The front door for someone holding a minted access code (see
// app/actions/auth-flow.ts and HOUSEHOLDS_PLAN.md "Access codes & the web
// of trust"): name + email + code, then the emailed six-digit code, then
// straight into /onboarding with the access code carried along. Invitees
// joining an EXISTING household don't come here — their invitation vouches
// for them on plain /signin. Ported from jinglejotter.com's
// app/signup/page.tsx, restyled to MediaVault's dark palette.

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ otp?: string; error?: string }>;
}) {
  const { otp, error } = await searchParams;

  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) redirect("/");

  const otpEmail = otp ? (await cookies()).get(OTP_EMAIL_COOKIE)?.value : undefined;

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-border bg-bg-elevated p-8 text-center shadow-lg shadow-black/30">
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-display text-3xl tracking-wide text-text">Set up your account</h1>
          <p className="text-sm text-text-muted">
            {otpEmail ? (
              <>
                We emailed a six-digit code to{" "}
                <span className="font-semibold text-text">{otpEmail}</span>. Type it below to
                finish setting up — it expires in 10 minutes.
              </>
            ) : (
              <>
                MediaVault is invite-only. Enter the access code you were given, using the email
                address it was sent for.
              </>
            )}
          </p>
        </div>

        {error === "SendFailed" && (
          <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
            Couldn&apos;t send your code — try again in a moment.
          </p>
        )}

        {otpEmail ? (
          <>
            <OTPForm />
            <div className="flex items-center gap-4 text-xs text-text-faint">
              <form action={requestOTP}>
                <input type="hidden" name="flow" value="signup" />
                <input type="hidden" name="email" value={otpEmail} />
                <button type="submit" className="underline-offset-2 hover:text-text-muted hover:underline">
                  Resend the code
                </button>
              </form>
              <Link href="/signup" className="underline-offset-2 hover:text-text-muted hover:underline">
                Start over
              </Link>
            </div>
          </>
        ) : (
          <>
            <SignupForm />
            <p className="text-xs text-text-faint">
              Already have an account?{" "}
              <Link href="/signin" className="font-semibold text-accent underline-offset-2 hover:underline">
                Sign in
              </Link>{" "}
              · Joining someone&apos;s household? Use the invite link they sent you.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
