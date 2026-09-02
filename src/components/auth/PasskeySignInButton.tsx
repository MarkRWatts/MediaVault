"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { usePasskeySupport } from "@/lib/use-passkey-support";

/** "Sign in with a passkey" on /signin (PASSKEYS_PLAN.md Phase 3), plus
 *  the browser's conditional-UI autofill: on a device that supports it,
 *  the passkey is offered inside the email field's own autofill sheet
 *  (the field carries autoComplete="username webauthn"), so the common
 *  path is one tap with no button at all. The button is the fallback for
 *  browsers without conditional mediation and for people who dismissed
 *  the sheet.
 *
 *  Client-side by necessity — the WebAuthn ceremony is a browser API — so
 *  unlike the OTP flow's server actions this talks to /api/auth/passkey/*
 *  directly through authClient. The session cookie is set by that
 *  response; the hard router.refresh() afterwards is what makes proxy.ts
 *  and every getSession()-reading server component see it (same reason
 *  SignOutButton does it).
 *
 *  `callbackURL` has already been through safeCallbackURL on the server
 *  page — this component never redirects anywhere the page didn't
 *  validate. */
export function PasskeySignInButton({ callbackURL }: { callbackURL: string }) {
  const router = useRouter();
  // "unknown" on the server and during hydration, so SSR renders nothing
  // and the button appears (or not) on the first client render.
  const supported = usePasskeySupport() === "yes";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Autofill and the button can both succeed for one page — never
  // navigate twice.
  const navigated = useRef(false);

  const finish = useCallback(() => {
    if (navigated.current) return;
    navigated.current = true;
    // Stays pending for good: the page is navigating away, and a second
    // ceremony started from the button meanwhile would only mint a
    // second session.
    setPending(true);
    router.push(callbackURL);
    router.refresh();
  }, [router, callbackURL]);

  useEffect(() => {
    if (!supported) return;

    let cancelled = false;
    (async () => {
      const conditional = await window.PublicKeyCredential.isConditionalMediationAvailable?.().catch(
        () => false,
      );
      if (!conditional || cancelled) return;
      // Resolves only when the person picks a passkey from the autofill
      // sheet. Any error here is deliberately silent: the pending
      // ceremony is aborted whenever the button's modal ceremony starts
      // (@simplewebauthn/browser cancels the previous one) or the page
      // navigates away, and neither is something to tell the user about.
      const result = await authClient.signIn.passkey({ autoFill: true });
      if (cancelled || result.error) return;
      finish();
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, finish]);

  async function signIn() {
    setPending(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    setPending(false);
    if (result.error) {
      setError(describe(result.error));
      return;
    }
    finish();
  }

  if (!supported) return null;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-text-faint">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-border px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Waiting for your device…" : "Sign in with a passkey"}
      </button>
      {error && <p className="text-sm text-missing">{error}</p>}
    </div>
  );
}

/** Three user-facing outcomes and no more — the same one-message-per-
 *  failure-class posture as verifyOTP, so nothing here distinguishes "no
 *  such passkey" from "passkey exists but the web of trust refused a
 *  session" (that refusal surfaces as UNABLE_TO_CREATE_SESSION, a 500). */
function describe(error: { code?: string; status: number }): string | null {
  const code = error.code ?? "";
  // They dismissed the browser's prompt (or a second ceremony aborted
  // this one) — say nothing.
  if (code === "AUTH_CANCELLED" || code === "ERROR_CEREMONY_ABORTED") return null;
  if (code === "PASSKEY_NOT_FOUND" || code === "AUTHENTICATION_FAILED") {
    return "That passkey isn't set up for MediaVault — use the email code instead.";
  }
  return "Couldn't sign you in with that passkey — use the email code instead.";
}
