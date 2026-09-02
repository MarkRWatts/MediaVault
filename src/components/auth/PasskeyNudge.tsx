"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePasskeySupport } from "@/lib/use-passkey-support";

// Per-device, not server state: "I don't want a passkey on this laptop"
// says nothing about their phone. Wrapped in try/catch because storage can
// be unavailable (private windows, storage blocked) — then the strip just
// shows again next time, which is the harmless failure.
const DISMISSED_KEY = "mv-passkey-nudge-dismissed";
const subscribeNever = () => () => {};
function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? "";
  } catch {
    return "";
  }
}

/** One-time strip on the library page after an email-code sign-in
 *  (PASSKEYS_PLAN.md Phase 4) — the page renders it only when verifyOTP's
 *  cookie is present, and it renders itself only on a device that can
 *  actually make a passkey, and only until dismissed here. "Add a
 *  passkey" also counts as a dismissal: from /account the person either
 *  adds one (no nudge needed) or decides not to (no nudge wanted). */
export function PasskeyNudge() {
  const support = usePasskeySupport();
  const stored = useSyncExternalStore(subscribeNever, readDismissed, () => "");
  const [dismissed, setDismissed] = useState(false);

  if (support !== "yes" || stored === "1" || dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // See DISMISSED_KEY.
    }
    setDismissed(true);
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-3 border-b border-border bg-bg-elevated px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <p className="text-text-muted">
        <span className="font-medium text-text">Sign in faster next time</span> — add a passkey
        for this device and skip the email code (Face ID, Touch ID, Windows Hello).
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/account#passkeys"
          onClick={dismiss}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10 sm:min-h-0"
        >
          Add a passkey
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex min-h-10 items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text sm:min-h-0"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
