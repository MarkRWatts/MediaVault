"use client";

import { useActionState } from "react";
import { verifyOTP, type ActionState } from "@/app/actions/auth-flow";

/** Step 2 of both sign-in and sign-up: type the six digits from the email.
 *  autoComplete="one-time-code" lets a browser/OS offer the code straight
 *  from the mail app. Ported from jinglejotter.com's
 *  components/auth/OTPForm.tsx, restyled to MediaVault's dark palette. */
export function OTPForm({
  callbackURL = "/",
  oauthQuery,
}: {
  callbackURL?: string;
  /** Signed oauth-provider query threaded through from /signin — see
   *  HOUSEHOLDS_PLAN.md "Jellyfin SSO". Undefined for a plain sign-in. */
  oauthQuery?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(verifyOTP, null);

  return (
    <form action={formAction} className="flex w-full max-w-xs flex-col gap-3">
      <input type="hidden" name="callbackURL" value={callbackURL} />
      {oauthQuery !== undefined && <input type="hidden" name="oauthQuery" value={oauthQuery} />}
      <input
        type="text"
        name="otp"
        required
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoComplete="one-time-code"
        autoFocus
        placeholder="123456"
        className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-center text-lg tracking-[0.5em] text-text placeholder:text-text-faint focus-visible:outline-none"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        {pending ? "Checking…" : "Sign in"}
      </button>
      {state?.error && <p className="text-sm text-missing">{state.error}</p>}
    </form>
  );
}
