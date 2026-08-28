"use client";

import { useActionState, useState } from "react";
import { deleteAccount } from "@/app/actions/account";

const CONFIRM_WORD = "DELETE";

/** Same modal-confirmation shape as RemoveMemberButton, with one addition:
 *  a household's only owner gets a second, stronger confirmation — typing
 *  the household's exact name — since deleting their account in that case
 *  takes the whole household with it, not just their own access. Ported
 *  from the template app's components/account/DeleteAccountButton.tsx,
 *  restyled to MediaVault's dark palette. */
export function DeleteAccountButton({
  householdName,
  soleOwner,
  otherMemberCount,
}: {
  householdName: string | null;
  soleOwner: boolean;
  otherMemberCount: number;
}) {
  const [state, formAction, pending] = useActionState(deleteAccount, null);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [confirmName, setConfirmName] = useState("");

  function close() {
    setOpen(false);
    setConfirmText("");
    setConfirmName("");
  }

  const ready = confirmText === CONFIRM_WORD && (!soleOwner || confirmName === householdName);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-missing transition-colors hover:text-missing/80"
      >
        Delete account
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-heading"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-bg-elevated p-6 shadow-lg shadow-black/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="delete-account-heading" className="font-display text-lg tracking-wide text-text">
                Delete your account?
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Cancel"
                className="shrink-0 text-text-faint transition-colors hover:text-text"
              >
                ✕
              </button>
            </div>

            {soleOwner ? (
              <p className="rounded-md border border-missing-border bg-missing-bg px-3 py-2 text-sm text-missing">
                You&apos;re the only owner of &ldquo;{householdName}&rdquo;. Deleting your account
                deletes the <strong>entire household</strong>
                {otherMemberCount > 0 ? ", for everyone in it" : ""} — for good. If you&apos;d
                rather keep it going, cancel and promote another member to owner first.
              </p>
            ) : (
              <p className="text-sm text-text-muted">
                {householdName
                  ? `You'll lose access to ${householdName}, but nothing you've added is deleted.`
                  : "This permanently deletes your account."}{" "}
                This can&apos;t be undone.
              </p>
            )}

            <form action={formAction} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-text-muted">
                  Type {CONFIRM_WORD} to confirm
                </span>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  className="rounded-md border border-border bg-bg-elevated-2 px-3 py-2 text-sm text-text focus-visible:outline-none"
                />
              </label>

              {soleOwner && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-text-muted">
                    Type &ldquo;{householdName}&rdquo; to confirm deleting the household
                  </span>
                  <input
                    type="text"
                    name="confirmHouseholdName"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    autoComplete="off"
                    className="rounded-md border border-border bg-bg-elevated-2 px-3 py-2 text-sm text-text focus-visible:outline-none"
                  />
                </label>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex min-h-10 items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text sm:min-h-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!ready || pending}
                  className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing px-4 py-2 text-sm font-medium text-missing shadow-sm transition-colors hover:bg-missing-bg disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                >
                  Delete account
                </button>
              </div>
              {state?.error && <p className="text-sm text-missing">{state.error}</p>}
            </form>
          </div>
        </div>
      )}
    </>
  );
}
