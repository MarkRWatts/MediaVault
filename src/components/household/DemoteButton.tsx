"use client";

import { useActionState } from "react";
import { demoteToMember } from "@/app/actions/household";

/** Ported from the template app's components/household/DemoteButton.tsx,
 *  restyled to MediaVault's dark palette. */
export function DemoteButton({ memberId, name }: { memberId: string; name: string }) {
  const [state, formAction, pending] = useActionState(demoteToMember, null);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !confirm(`Make ${name} a plain member? They'll lose the ability to invite or remove people.`)
        ) {
          e.preventDefault();
        }
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="memberId" value={memberId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        Make member
      </button>
      {state?.error && <p className="max-w-[10rem] text-right text-xs text-missing">{state.error}</p>}
    </form>
  );
}
