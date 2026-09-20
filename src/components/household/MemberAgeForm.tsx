"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { setMemberDateOfBirth, type ActionState } from "@/app/actions/household";

/** The age-rating control on a member's row in /account: a date of birth
 *  that turns them into a restricted viewer, and the summary of what that
 *  currently lets them see. Owner-only, and only rendered for role="member"
 *  rows — the action enforces both (see setMemberDateOfBirth).
 *
 *  `dateOfBirth` is a YYYY-MM-DD string, not a Date: the page formats it
 *  server-side so nothing here depends on a locale or timezone the server
 *  and browser might disagree about. `summary` likewise arrives pre-built
 *  (ageLimitLabel) rather than being recomputed from the date on the client,
 *  where "today" could be a different day than the server's. */
export function MemberAgeForm({
  memberId,
  name,
  dateOfBirth,
  summary,
  today,
}: {
  memberId: string;
  name: string;
  /** Their current restriction, or "" for none. */
  dateOfBirth: string;
  /** e.g. "12 years old — U, PG, 12A and 12"; null when unrestricted. */
  summary: string | null;
  /** Today in YYYY-MM-DD, for the picker's max — from the server, so it
   *  matches the date the action validates against. */
  today: string;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(setMemberDateOfBirth, null);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) setEditing(false);
    wasPending.current = pending;
  }, [pending, state]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={summary ? `${name}: ${summary}` : `Set an age rating for ${name}`}
        className={`inline-flex min-h-10 items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors sm:min-h-0 ${
          summary
            ? "border-accent/60 text-accent hover:bg-accent/10"
            : "border-border text-text-faint hover:border-accent hover:text-accent"
        }`}
      >
        {summary ?? "Set age rating"}
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="memberId" value={memberId} />
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`dob-${memberId}`}>
          {name}&rsquo;s date of birth
        </label>
        <input
          id={`dob-${memberId}`}
          type="date"
          name="dateOfBirth"
          defaultValue={dateOfBirth}
          max={today}
          autoFocus
          className="rounded-md border border-border bg-bg-elevated-2 px-2.5 py-1.5 text-sm text-text focus-visible:outline-none"
        />
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
          className="inline-flex min-h-10 items-center justify-center rounded-md px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text sm:min-h-0"
        >
          Cancel
        </button>
      </div>
      <p className="max-w-xs text-right text-xs text-text-faint">
        Leave the date empty and save to lift the restriction. Anything without a BBFC certificate
        stays hidden from a restricted member.
      </p>
      {state?.error && <p className="max-w-xs text-right text-xs text-missing">{state.error}</p>}
    </form>
  );
}
