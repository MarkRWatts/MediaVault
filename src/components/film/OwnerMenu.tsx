"use client";

// The film and show pages' round "⋯" (FILM_PAGE_PLAN.md and
// SHOW_PAGE_PLAN.md "Top"): only drawn when there's something in it, which
// today means the app owner — for whom a film's holds the physical-copy log
// that used to sit under the Versions list, and a show's holds "Link to a
// film". Members see no button at all. The routes and server actions behind
// what's inside refuse anyone else regardless (requireOwnerOrResponse in
// /api/film-physical, requireOwner() in the film-show link actions).

import { useEffect, useState, type ReactNode } from "react";
import { Ellipsis, X } from "lucide-react";

export default function OwnerMenu({
  heading,
  children,
}: {
  /** The sheet's title, and its accessible name. */
  heading: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="More"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white shadow-lg shadow-black/30 backdrop-blur-md transition-colors hover:bg-black/60"
      >
        <Ellipsis aria-hidden className="h-5 w-5" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={heading}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center sm:px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-md flex-col gap-3 rounded-t-2xl border border-border bg-bg-elevated-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg shadow-black/50 sm:rounded-2xl sm:pb-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-text">{heading}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-text-faint transition-colors hover:text-text"
              >
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            {children}
          </div>
        </div>
      )}
    </>
  );
}
