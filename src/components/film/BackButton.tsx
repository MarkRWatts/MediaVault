"use client";

// The film page's round, translucent Back button, floating over the
// artwork where the logo bar would be (FILM_PAGE_PLAN.md "Top"). Goes back
// through history when there's an earlier page in this tab to go back to —
// Home, a search, a show — and otherwise to the section the film lives in,
// so a film opened from a shared link still has a way out.

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

export default function BackButton({ fallbackHref, label }: { fallbackHref: string; label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={`Back to ${label}`}
      title="Back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push(fallbackHref);
      }}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white shadow-lg shadow-black/30 backdrop-blur-md transition-colors hover:bg-black/60"
    >
      <ChevronLeft aria-hidden className="h-6 w-6 -translate-x-px" />
    </button>
  );
}
