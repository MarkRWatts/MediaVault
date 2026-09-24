"use client";

// Floating bottom tab bar for mobile (<md), hidden at md+ where the sidebar
// takes over. Floats clear of the iOS home-indicator swipe zone in the same
// glass language as the desktop sidebar. The iPhone app's five tabs —
// Home · Movies · Shows · Music · Search (FILM_PAGE_PLAN.md "Everywhere") —
// and nothing else: Collections, History, Adult, the owner tools and
// Account live behind the avatar in the top bar (top-nav.tsx). Ported from
// template-app / TrainTracker's bottom-tabs.tsx.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavItemActive, navItemsFor, type NavFlags } from "./nav-items";

const tabClass = (active: boolean) =>
  `flex flex-1 flex-col items-center gap-0.5 px-0.5 py-1.5 font-display text-[10px] font-medium tracking-wide whitespace-nowrap transition-colors ${
    active ? "text-accent" : "text-text-muted"
  }`;

export function BottomTabs({ flags }: { flags: NavFlags }) {
  const pathname = usePathname();
  const { primary } = navItemsFor(flags);

  return (
    // Same glass recipe as the desktop sidebar (sidebar.tsx).
    <nav
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-40 rounded-2xl border border-border bg-bg-elevated/90 shadow-lg shadow-black/40 backdrop-blur-md md:hidden"
      aria-label="Primary"
    >
      <div className="flex items-stretch justify-around px-1 py-1">
        {primary.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={tabClass(active)}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
