"use client";

// Top-right identity control: the signed-in person's avatar and name, which
// opens a small menu holding what used to be two separate nav items — the
// Account link and the Sign out button (plus Admin, for the app owner).
// Shows WHO is signed in on every page, which the old bare "Sign out"
// button never did in a shared-household app.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { UserAvatar } from "@/components/UserAvatar";

export default function UserMenu({
  name,
  email,
  image,
  isOwner = false,
}: {
  name: string | null;
  email: string | null;
  image: string | null;
  isOwner?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Close on outside click and Escape — the two things every dropdown owes.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayName = name?.trim() || email || "Account";

  // Same mechanics as the old SignOutButton: authClient.signOut() clears
  // the cookie via /api/auth/*, then a hard navigation so proxy.ts and every
  // server component see the signed-out state, not a stale router cache.
  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      router.push("/signin");
      router.refresh();
    }
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${displayName}`}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-10 items-center gap-2 rounded-full py-0.5 pl-0.5 pr-3 transition-colors hover:bg-bg-hover ${
          open ? "bg-bg-hover" : ""
        }`}
      >
        <UserAvatar name={name} email={email} image={image} size={32} />
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-text sm:inline">{displayName}</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border border-border bg-bg-elevated p-1.5 shadow-lg shadow-black/40"
        >
          <div className="flex items-center gap-3 px-3 py-2">
            <UserAvatar name={name} email={email} image={image} size={40} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-text">{displayName}</span>
              {email && <span className="truncate text-xs text-text-faint">{email}</span>}
            </div>
          </div>
          <div className="my-1 border-t border-border" />
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className={itemClass}>
            Account
          </Link>
          {isOwner && (
            <Link role="menuitem" href="/admin" onClick={() => setOpen(false)} className={itemClass}>
              Admin
            </Link>
          )}
          <div className="my-1 border-t border-border" />
          <button role="menuitem" type="button" disabled={signingOut} onClick={signOut} className={`${itemClass} disabled:opacity-40`}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
