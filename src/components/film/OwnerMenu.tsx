"use client";

// The film page's round "⋯" (FILM_PAGE_PLAN.md "Top"): only drawn when
// there's something in it, which today means the app owner, for whom it
// holds the physical-copy log that used to sit under the Versions list.
// Members see no button at all. The API refuses anyone else regardless
// (requireOwnerOrResponse in /api/film-physical).

import { useEffect, useState } from "react";
import { Ellipsis, X } from "lucide-react";
import FilmPhysicalCopyForm from "@/components/FilmPhysicalCopyForm";
import type { FilmPhysicalCopyView } from "@/lib/queries";

export default function OwnerMenu({
  filmId,
  physicalCopies,
}: {
  filmId: number;
  physicalCopies: FilmPhysicalCopyView[];
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
          aria-label="Physical copies"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center sm:px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-md flex-col gap-3 rounded-t-2xl border border-border bg-bg-elevated-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg shadow-black/50 sm:rounded-2xl sm:pb-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-text">Physical copies</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-text-faint transition-colors hover:text-text"
              >
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col items-start gap-3">
              {(["DVD", "BLURAY", "UHD"] as const).map((medium) => (
                <FilmPhysicalCopyForm
                  key={medium}
                  filmId={filmId}
                  medium={medium}
                  initial={physicalCopies.find((c) => c.medium === medium) ?? null}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
