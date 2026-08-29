"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/actions/household";

/** Ported from jinglejotter.com's components/household/CreateHouseholdForm.tsx,
 *  restyled to MediaVault's dark palette. */
export function CreateHouseholdForm({
  action,
  defaultName = "",
  defaultCode = "",
}: {
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  defaultName?: string;
  /** Pre-filled from the /signup flow's cookie (lib/flow-cookies.ts) so the
   *  code is typed once, not twice. Still a visible, editable field. */
  defaultCode?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input
        type="text"
        name="name"
        required
        maxLength={60}
        defaultValue={defaultName}
        placeholder="e.g. The Watts household"
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-border bg-bg-elevated-2 px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
      />
      {/* Server-side normalization (lib/access.ts) forgives case and
          separators, so no input masking needed — any reasonable attempt at
          "MV-XXXX-XXXX" goes through. */}
      <input
        type="text"
        name="code"
        required
        maxLength={20}
        defaultValue={defaultCode}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="Access code, e.g. MV-ABCD-2345"
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-border bg-bg-elevated-2 px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        {pending ? "Creating…" : "Create household"}
      </button>
      {state?.error && <p className="text-sm text-missing">{state.error}</p>}
    </form>
  );
}
