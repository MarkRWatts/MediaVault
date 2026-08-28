"use client";

import { useActionState, useRef } from "react";
import { createInvitation } from "@/app/actions/household";

/** Ported from jinglejotter.com's components/household/InviteForm.tsx,
 *  minus the "appOnly" no-household branch (a growth-marketing concept that
 *  doesn't apply here — see HOUSEHOLDS_PLAN.md Phase 4), restyled to
 *  MediaVault's dark palette. */
export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvitation, null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData);
        formRef.current?.reset();
      }}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:flex-row sm:items-end sm:gap-4"
    >
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
      {state?.error && <p className="w-full text-sm text-missing">{state.error}</p>}
    </form>
  );
}
