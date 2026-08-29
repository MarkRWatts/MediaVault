"use client";

import { useActionState } from "react";
import { registerJellyfinClient, type JellyfinClientState } from "@/app/actions/admin";

/** One-time registration of Jellyfin as an OAuth client — see
 *  HOUSEHOLDS_PLAN.md "Jellyfin SSO". Modeled on MintCodeForm.tsx: the
 *  secret is shown exactly once, in the action's result, and never stored
 *  anywhere MediaVault itself can show it again. */
export function JellyfinClientForm() {
  const [state, formAction, pending] = useActionState<JellyfinClientState, FormData>(
    registerJellyfinClient,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
      <label className="flex flex-col gap-1 text-sm text-text-muted">
        Jellyfin redirect URI
        <input
          type="url"
          name="redirectUri"
          required
          placeholder="https://jellyfin.example.lan/sso/OID/redirect/MediaVault"
          className="w-full rounded-md border border-border bg-bg-elevated-2 px-3 py-2 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center justify-center self-start rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        {pending ? "Registering…" : "Register client"}
      </button>
      {state && "error" in state && <p className="text-sm text-missing">{state.error}</p>}
      {state && "clientId" in state && (
        <div className="flex flex-col gap-1 rounded-md border border-accent-border bg-accent-dim p-3 text-sm">
          <p className="text-accent">
            Paste these into jellyfin-plugin-sso&apos;s provider config — shown once, never stored
            here.
          </p>
          <p className="font-mono text-text">client_id: {state.clientId}</p>
          <p className="font-mono text-text">client_secret: {state.clientSecret}</p>
        </div>
      )}
    </form>
  );
}
