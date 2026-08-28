"use client";

import { useActionState } from "react";
import { mintAccessCode, type AdminActionState } from "@/app/actions/admin";

const inputClass =
  "w-full rounded-md border border-border bg-bg-elevated-2 px-3 py-2 text-sm text-text placeholder:text-text-faint focus-visible:outline-none";

/** Ported from the template app's components/admin/MintCodeForm.tsx,
 *  restyled to MediaVault's dark palette. */
export function MintCodeForm() {
  const [state, formAction, pending] = useActionState<AdminActionState, FormData>(
    mintAccessCode,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          type="email"
          name="email"
          placeholder="Email (optional — binds sign-in to it)"
          className={inputClass}
        />
        <input
          type="text"
          name="note"
          maxLength={120}
          placeholder="Note, e.g. Sarah from work"
          className={inputClass}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-text-muted">
        Redeemable until
        <input
          type="date"
          name="until"
          className="rounded-md border border-border bg-bg-elevated-2 px-3 py-1.5 text-sm text-text focus-visible:outline-none"
        />
        <span className="text-xs text-text-faint">(leave empty for no cutoff)</span>
      </label>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" name="send" className="size-4 accent-accent" />
        Email the code to them now
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center self-start rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        {pending ? "Minting…" : "Mint code"}
      </button>
      {state?.error && <p className="text-sm text-missing">{state.error}</p>}
      {state?.minted && (
        <p className="text-sm text-accent">
          Minted <span className="font-medium tracking-wide">{state.minted}</span> — it&apos;s in
          the table below.
        </p>
      )}
    </form>
  );
}
