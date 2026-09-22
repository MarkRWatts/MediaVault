"use client";

// The Playlists / Artists / Albums switcher at the top of the three
// top-level music pages — same idea as the iOS app's Music-screen segmented
// control (IOS_PLAN.md). A plain nav of three routes, not client-side view
// state: each destination is a real page, so back/forward and deep links
// behave normally. Deliberately not a layout under /music — the artist,
// album and playlist detail pages must not show it, so each of the three
// index pages renders it itself. Pill styling matches LibraryBrowser's
// FILTERS group.

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/music/playlists", label: "Playlists" },
  { href: "/music", label: "Artists" },
  { href: "/music/albums", label: "Albums" },
] as const;

export function MusicViewSwitcher() {
  const pathname = usePathname();

  return (
    <div className="flex w-full items-stretch gap-1.5 sm:w-auto sm:items-center" role="group" aria-label="Music view">
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-10 flex-1 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 sm:flex-none sm:px-4 ${
              active
                ? "border-accent-border bg-accent-dim text-accent"
                : "border-border text-text-muted hover:border-border-strong hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
