"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { updateHouseholdName, type ActionState } from "@/app/actions/household";

/** Household name heading with an inline edit affordance, owner-only.
 *  Ported from the template app's components/household/RenameHouseholdForm.tsx,
 *  restyled to MediaVault's dark palette. */
export function RenameHouseholdForm({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateHouseholdName,
    null,
  );
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) setEditing(false);
    wasPending.current = pending;
  }, [pending, state]);

  if (!editing) {
    return (
      <div className="group flex items-center gap-1.5">
        <h2 className="font-display text-xl tracking-wide text-text">{name}</h2>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Rename household"
          className="text-text-faint transition-colors hover:text-accent"
        >
          <span aria-hidden>✎</span>
          <span className="sr-only">Rename household</span>
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input
        name="name"
        defaultValue={name}
        autoFocus
        required
        maxLength={60}
        className="rounded-md border border-border bg-bg-elevated-2 px-3 py-1.5 text-sm text-text focus-visible:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex min-h-10 items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text sm:min-h-0"
        >
          Cancel
        </button>
      </div>
      {state?.error && <p className="text-xs text-missing">{state.error}</p>}
    </form>
  );
}
