"use client";

import { startTransition, useActionState, useState } from "react";
import { toggleAdultLibraryAccess, retryJellyfinAdultSync, type AdultAccessState } from "@/app/actions/adult";

/** Self-service opt-in for the Adult media type — see ADULT_PLAN.md
 *  (local-only). Submits on change rather than needing a separate Save
 *  button; a Jellyfin failure never blocks the MediaVault-side toggle
 *  (see toggleAdultLibraryAccess's doc comment) — this just surfaces its
 *  status alongside, with a Retry affordance for the first-login
 *  chicken-and-egg case (their Jellyfin account doesn't exist yet). */
export function AdultAccessToggle({
  initialEnabled,
  initiallyLinked,
}: {
  initialEnabled: boolean;
  initiallyLinked: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, formAction, pending] = useActionState<AdultAccessState, FormData>(toggleAdultLibraryAccess, null);
  const [retryState, retryAction, retryPending] = useActionState<AdultAccessState, FormData>(
    retryJellyfinAdultSync,
    null,
  );

  // Derived, not synced via an effect: a "synced" result from either action
  // means linked-ness has changed, no need for its own state variable.
  const lastJellyfin = retryState?.jellyfin ?? state?.jellyfin;
  const linked = initiallyLinked || lastJellyfin?.status === "synced";
  const waitingOnJellyfin = enabled && !linked && lastJellyfin?.status !== "error";

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setEnabled(next);
            // Dispatched directly rather than via a real <form> submission —
            // React 19 resets a submitted form's fields once the action
            // resolves, and a controlled checkbox whose bound value hasn't
            // changed doesn't get its DOM `checked` reasserted afterward, so
            // it visually snaps back to unchecked despite `enabled`/the DB
            // being correct. Calling the action directly never triggers
            // that native reset.
            const formData = new FormData();
            if (next) formData.set("enabled", "true");
            startTransition(() => formAction(formData));
          }}
          className="size-4 accent-accent"
        />
        Show Adult content in MediaVault
      </label>
      {state?.error && <p className="text-xs text-missing">{state.error}</p>}
      {waitingOnJellyfin && (
        <div className="text-xs text-text-faint">
          Waiting for your first Jellyfin sign-in to grant access there too —{" "}
          <form action={retryAction} className="inline">
            <button
              type="submit"
              disabled={retryPending}
              className="text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            >
              {retryPending ? "Retrying…" : "Retry"}
            </button>
          </form>
        </div>
      )}
      {lastJellyfin?.status === "error" && (
        <p className="text-xs text-missing">Jellyfin sync failed: {lastJellyfin.message}</p>
      )}
    </div>
  );
}
