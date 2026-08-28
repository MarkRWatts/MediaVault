"use client";

import { useActionState, useState } from "react";
import { removeMember } from "@/app/actions/household";

const CONFIRM_WORD = "DELETE";

// A plain confirm() can't hold a text input, so removing someone from a
// household gets its own small dialog instead. A successful removal takes
// this member's whole row (including this dialog) out of the tree on the
// next server-driven re-render, so there's no need to manually close on
// success; only Cancel/Escape/backdrop-click close it without submitting.
// Ported from the template app's components/household/RemoveMemberButton.tsx,
// restyled to MediaVault's dark palette.
export function RemoveMemberButton({ memberId, name }: { memberId: string; name: string }) {
  const [state, formAction, pending] = useActionState(removeMember, null);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  function close() {
    setOpen(false);
    setConfirmText("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing-border px-3 py-1 text-xs font-medium text-missing transition-colors hover:bg-missing-bg sm:min-h-0"
      >
        Remove
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-member-heading"
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
              <h2 id="remove-member-heading" className="font-display text-lg tracking-wide text-text">
                Remove {name}?
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
            <p className="text-sm text-text-muted">
              They&apos;ll lose access, but nothing they&apos;ve added is deleted.
            </p>
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="memberId" value={memberId} />
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
                  disabled={confirmText !== CONFIRM_WORD || pending}
                  className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing px-4 py-2 text-sm font-medium text-missing shadow-sm transition-colors hover:bg-missing-bg disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                >
                  Remove
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
