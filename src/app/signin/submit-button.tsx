"use client";

import { useFormStatus } from "react-dom";

// Disables itself while the action is in flight, so a slow OTP send/verify
// or invite-accept can't be double-submitted by an impatient click. Ported
// from jinglejotter.com's app/signin/submit-button.tsx, restyled to
// MediaVault's own outline-accent button convention (see e.g.
// FilmPhysicalCopyForm.tsx) instead of that app's solid berry pill.
export function SubmitButton({
  children,
  pendingText = "Working…",
}: {
  children: React.ReactNode;
  pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
    >
      {pending ? pendingText : children}
    </button>
  );
}
