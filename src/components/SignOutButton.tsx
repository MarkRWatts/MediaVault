"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

// Item 10 of HOUSEHOLDS_PLAN.md Phase 4: a small sign-out control in the
// nav. Client-side since authClient.signOut() clears the session cookie via
// a fetch to /api/auth/*, then we hard-navigate to /signin so proxy.ts's
// cookie-presence check (and every server component relying on
// getSession()) sees the signed-out state immediately rather than serving
// a stale client-router cache entry.
export default function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await authClient.signOut();
        } finally {
          router.push("/signin");
          router.refresh();
        }
      }}
      className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-2.5 py-1 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
