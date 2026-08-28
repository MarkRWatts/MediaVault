"use client";

import { useActionState, useState } from "react";
import { cancelInvitation } from "@/app/actions/household";

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Ported from jinglejotter.com's components/household/PendingInviteRow.tsx,
 *  restyled to MediaVault's dark palette. No email-sending is wired up for
 *  household invites yet (Phase 3's auth.ts doesn't configure
 *  sendInvitationEmail) — the copy-link button is the actual delivery
 *  mechanism for this phase. */
export function PendingInviteRow({
  id,
  email,
  expiresAt,
}: {
  id: string;
  email: string;
  expiresAt: string;
}) {
  const [state, formAction, pending] = useActionState(cancelInvitation, null);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const url = `${window.location.origin}/invite/${id}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-text">{email}</span>
        <span className="text-xs text-text-faint">Expires {formatExpiry(expiresAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text sm:min-h-0"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <form action={formAction}>
          <input type="hidden" name="invitationId" value={id} />
          <button
            type="submit"
            disabled={pending}
            title="Cancel invite"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-missing-bg hover:text-missing disabled:opacity-40"
          >
            ✕
          </button>
        </form>
      </div>
      {state?.error && <p className="w-full text-xs text-missing">{state.error}</p>}
    </div>
  );
}
