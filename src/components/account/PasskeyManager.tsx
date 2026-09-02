"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { PASSKEY_NAME_MAX_LENGTH, suggestPasskeyName } from "@/lib/passkey-label";
import { usePasskeySupport, useUserAgent } from "@/lib/use-passkey-support";
import { renamePasskey, removePasskey, type PasskeyActionState } from "@/app/actions/passkeys";
import SignOutButton from "@/components/SignOutButton";

/** One row of /account's Passkeys section — shaped by the page, which
 *  resolves the AAGUID label and formats the date server-side so nothing
 *  locale-dependent has to agree between server and client render. */
export type PasskeyRow = {
  id: string;
  name: string | null;
  /** Pre-formatted "added" date. */
  added: string;
  backedUp: boolean;
  /** Authenticator make from the AAGUID, when known (it isn't for most
   *  Apple passkeys — see src/lib/passkey-label.ts). */
  authenticator: string | null;
};

/** The Passkeys section of /account (PASSKEYS_PLAN.md Phase 2): list,
 *  rename, remove, add. Rename/remove go through server actions like every
 *  other mutation on this page; add has to be client-side because the
 *  WebAuthn ceremony is a browser API — after it succeeds the page is
 *  refreshed so the new row arrives from the server like the others. */
export function PasskeyManager({ passkeys }: { passkeys: PasskeyRow[] }) {
  const router = useRouter();
  // "unknown" during SSR/hydration, so the add affordance appears on the
  // first client render rather than rendering then vanishing.
  const support = usePasskeySupport();
  const suggestedName = suggestPasskeyName(useUserAgent());
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plugin only allows registration from a session younger than
  // session.freshAge (24h by default) — a built-in sudo mode. Someone who
  // signed in a week ago gets a 403 here, which needs its own explanation,
  // not a generic failure.
  const [needsFreshSession, setNeedsFreshSession] = useState(false);

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const typed = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    const name = (typed || suggestedName).slice(0, PASSKEY_NAME_MAX_LENGTH);

    setPending(true);
    setError(null);
    const result = await authClient.passkey.addPasskey({ name });
    setPending(false);

    if (result.error) {
      const code = "code" in result.error ? result.error.code : "";
      // They dismissed the browser's own prompt — nothing to say.
      if (code === "ERROR_CEREMONY_ABORTED" || code === "REGISTRATION_CANCELLED") return;
      if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || code === "PREVIOUSLY_REGISTERED") {
        setError("This device already has a passkey for MediaVault.");
        return;
      }
      if (result.error.status === 403) {
        setNeedsFreshSession(true);
        setAdding(false);
        return;
      }
      setError("Couldn't add a passkey — try again in a moment.");
      return;
    }

    setAdding(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">
        Sign in with Face ID, Touch ID, Windows Hello or a security key instead of waiting for
        an email code. Each device gets its own passkey; the email code always still works.
      </p>

      {passkeys.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
          {passkeys.map((passkey) => (
            <PasskeyRowItem key={passkey.id} passkey={passkey} />
          ))}
        </div>
      )}

      {needsFreshSession ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-elevated px-4 py-3 text-sm text-text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>
            Passkeys can only be added within a day of signing in — sign out and back in first,
            then come back here.
          </span>
          <SignOutButton />
        </div>
      ) : support === "insecure" ? (
        <p className="text-xs text-text-faint">
          Passkeys need a secure (https) connection — open MediaVault over https to add one.
        </p>
      ) : support === "no" ? (
        <p className="text-xs text-text-faint">This browser doesn&apos;t support passkeys.</p>
      ) : support === "yes" && adding ? (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            name="name"
            defaultValue={suggestedName}
            autoFocus
            maxLength={PASSKEY_NAME_MAX_LENGTH}
            placeholder="Name this device"
            aria-label="Passkey name"
            className="rounded-md border border-border bg-bg-elevated-2 px-3 py-1.5 text-sm text-text focus-visible:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              {pending ? "Waiting for your device…" : "Create passkey"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="inline-flex min-h-10 items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : support === "yes" ? (
        <div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 sm:min-h-0"
          >
            Add a passkey for this device
          </button>
        </div>
      ) : null}
      {error && <p className="text-xs text-missing">{error}</p>}
    </div>
  );
}

function PasskeyRowItem({ passkey }: { passkey: PasskeyRow }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renameState, renameAction, renamePending] = useActionState<PasskeyActionState, FormData>(
    renamePasskey,
    null,
  );
  const [removeState, removeAction, removePending] = useActionState<PasskeyActionState, FormData>(
    removePasskey,
    null,
  );
  // Same close-on-success pattern as EditNameForm: a successful rename
  // re-renders this row from the server with the new name, so the inline
  // form just needs to fold away.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renamePending && !renameState?.error) setEditing(false);
    wasRenaming.current = renamePending;
  }, [renamePending, renameState]);

  const label = passkey.name || passkey.authenticator || "Passkey";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      {editing ? (
        <form action={renameAction} className="flex min-h-10 flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="id" value={passkey.id} />
          <input
            name="name"
            defaultValue={passkey.name ?? ""}
            autoFocus
            required
            maxLength={PASSKEY_NAME_MAX_LENGTH}
            aria-label="Passkey name"
            className="rounded-md border border-border bg-bg-elevated-2 px-3 py-1.5 text-sm text-text focus-visible:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={renamePending}
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
          {renameState?.error && <p className="text-xs text-missing">{renameState.error}</p>}
        </form>
      ) : (
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-sm font-medium text-text">
            <span className="truncate">{label}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Rename this passkey"
              className="text-text-faint transition-colors hover:text-accent"
            >
              <span aria-hidden>✎</span>
              <span className="sr-only">Rename this passkey</span>
            </button>
          </span>
          <span className="text-xs text-text-faint">
            Added {passkey.added}
            {passkey.authenticator && passkey.name ? ` · ${passkey.authenticator}` : ""}
            {" · "}
            {/* backedUp = the credential syncs via the platform's keychain
                (iCloud Keychain, Google Password Manager); otherwise it
                lives only on the one device that made it. */}
            {passkey.backedUp ? "synced across your devices" : "this device only"}
          </span>
        </div>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-2">
          {confirming ? (
            <form action={removeAction} className="flex items-center gap-2">
              <input type="hidden" name="id" value={passkey.id} />
              <span className="text-xs text-text-muted">Remove {label}?</span>
              <button
                type="submit"
                disabled={removePending}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing px-3 py-1 text-xs font-medium text-missing transition-colors hover:bg-missing-bg disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
              >
                {removePending ? "Removing…" : "Remove"}
              </button>
              <button
                type="button"
                disabled={removePending}
                onClick={() => setConfirming(false)}
                className="inline-flex min-h-10 items-center justify-center rounded-md px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:text-text sm:min-h-0"
              >
                Keep
              </button>
              {removeState?.error && <p className="text-xs text-missing">{removeState.error}</p>}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing-border px-3 py-1 text-xs font-medium text-missing transition-colors hover:bg-missing-bg sm:min-h-0"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
