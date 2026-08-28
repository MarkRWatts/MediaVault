"use client";

import { useActionState } from "react";
import { beginSignup, type SignupState } from "@/app/actions/auth-flow";

const inputClass =
  "w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none";

/** The three-field front door: name, email, minted access code. Client-side
 *  so a validation error keeps what was typed (three fields is too many to
 *  lose to a redirect). Ported from jinglejotter.com's
 *  components/auth/SignupForm.tsx, restyled to MediaVault's dark palette. */
export function SignupForm() {
  const [state, formAction, pending] = useActionState<SignupState, FormData>(beginSignup, null);

  return (
    <form action={formAction} className="flex w-full max-w-xs flex-col gap-3">
      {/* React 19 resets uncontrolled fields after every action — key each
          input by the echoed value so a failed submit re-fills what was
          typed instead of wiping three fields. */}
      <input
        key={`name-${state?.values?.name ?? ""}`}
        type="text"
        name="name"
        required
        maxLength={256}
        defaultValue={state?.values?.name ?? ""}
        placeholder="Your name"
        className={inputClass}
      />
      <input
        key={`email-${state?.values?.email ?? ""}`}
        type="email"
        name="email"
        required
        defaultValue={state?.values?.email ?? ""}
        placeholder="you@example.com"
        className={inputClass}
      />
      <input
        key={`code-${state?.values?.code ?? ""}`}
        type="text"
        name="code"
        required
        maxLength={20}
        defaultValue={state?.values?.code ?? ""}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="Access code, e.g. MV-ABCD-2345"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        {pending ? "Sending your code…" : "Create my account"}
      </button>
      {state?.error && <p className="text-sm text-missing">{state.error}</p>}
    </form>
  );
}
