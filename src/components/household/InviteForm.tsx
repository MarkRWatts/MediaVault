"use client";

import { useActionState, useRef, useState } from "react";
import { createInvitation } from "@/app/actions/household";

/** Ported from jinglejotter.com's components/household/InviteForm.tsx,
 *  restyled to MediaVault's dark palette. The "invite to the app only"
 *  tickbox is offered only to the app owner (`canInviteToApp`): in this
 *  app it mints an access code for a brand-new household, which is the app
 *  owner's gate, not a household owner's — see createInvitation. */
export function InviteForm({ canInviteToApp = false }: { canInviteToApp?: boolean }) {
  const [state, formAction, pending] = useActionState(createInvitation, null);
  // Flips the action from a household invite to a "come and use
  // MediaVault" one (no Invitation row; the recipient sets up their own
  // household).
  const [appOnly, setAppOnly] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData);
        formRef.current?.reset();
        setAppOnly(false);
      }}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Invite by email</span>
          <input
            type="email"
            name="email"
            required
            maxLength={256}
            placeholder="e.g. sam@example.com"
            className="w-full rounded-md border border-border bg-bg-elevated-2 px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </div>
      {canInviteToApp && (
        <label className="flex items-start gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            name="appOnly"
            checked={appOnly}
            onChange={(e) => setAppOnly(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
          />
          <span>
            Invite to MediaVault only — they&apos;ll get an access code to set up their own household and
            won&apos;t see yours.
          </span>
        </label>
      )}
      {state?.sent && <p className="text-sm text-text-muted">Invite sent to {state.sent}</p>}
      {state?.error && <p className="text-sm text-missing">{state.error}</p>}
    </form>
  );
}
