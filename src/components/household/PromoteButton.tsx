"use client";

import { useActionState } from "react";
import { promoteToOwner } from "@/app/actions/household";

/** Ported from the template app's components/household/PromoteButton.tsx,
 *  restyled to MediaVault's dark palette. */
export function PromoteButton({ memberId, name }: { memberId: string; name: string }) {
  const [state, formAction, pending] = useActionState(promoteToOwner, null);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(`Make ${name} an owner too? They'll be able to invite and remove people.`)) {
          e.preventDefault();
        }
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="memberId" value={memberId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        Make owner
      </button>
      {state?.error && <p className="max-w-[10rem] text-right text-xs text-missing">{state.error}</p>}
    </form>
  );
}
