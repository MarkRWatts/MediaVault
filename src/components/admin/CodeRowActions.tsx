"use client";

import { useActionState } from "react";
import { deleteAccessCode, sendCodeEmail, type AdminActionState } from "@/app/actions/admin";

/** Per-row send/revoke controls. Revoke only renders for unused codes — the
 *  server action re-checks that anyway (deleteMany's redeemedCount: 0
 *  filter), this is just honest UI. Ported from the template app's
 *  components/admin/CodeRowActions.tsx, restyled to MediaVault's dark
 *  palette. */
export function CodeRowActions({
  codeId,
  hasEmail,
  everSent,
  used,
}: {
  codeId: string;
  hasEmail: boolean;
  everSent: boolean;
  used: boolean;
}) {
  const [sendState, sendAction, sending] = useActionState<AdminActionState, FormData>(
    sendCodeEmail,
    null,
  );
  const [deleteState, deleteAction, deleting] = useActionState<AdminActionState, FormData>(
    deleteAccessCode,
    null,
  );
  const error = sendState?.error ?? deleteState?.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {hasEmail && (
          <form action={sendAction}>
            <input type="hidden" name="codeId" value={codeId} />
            <button
              type="submit"
              disabled={sending}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              {sending ? "Sending…" : everSent ? "Resend email" : "Send email"}
            </button>
          </form>
        )}
        {!used && (
          <form action={deleteAction}>
            <input type="hidden" name="codeId" value={codeId} />
            <button
              type="submit"
              disabled={deleting}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              {deleting ? "Revoking…" : "Revoke"}
            </button>
          </form>
        )}
      </div>
      {error && <p className="text-xs text-missing">{error}</p>}
    </div>
  );
}
