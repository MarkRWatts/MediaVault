"use client";

// Floating bottom tab bar for mobile (<md), hidden at md+ where the sidebar
// takes over. Floats clear of the iOS home-indicator swipe zone in the same
// glass language as the desktop sidebar. Four everyday tabs plus a "More"
// tab that opens a small sheet with the remaining destinations — Stats,
// Adult and the owner tools when this person has them, and Account, which
// the mobile header only shows as an avatar. Ported from template-app /
// TrainTracker's bottom-tabs.tsx.

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Ellipsis, UserRound } from "lucide-react";
import { isNavItemActive, navItemsFor, type NavFlags, type NavItem } from "./nav-items";

const sheetRow =
  "flex items-center gap-3 rounded-lg px-4 py-3 font-display text-sm font-medium tracking-wide transition-colors";

function sheetRowClass(active: boolean, owner: boolean) {
  if (owner) return `${sheetRow} ${active ? "bg-blu-bg text-blu" : "text-blu/70 hover:bg-blu-bg hover:text-blu"}`;
  return `${sheetRow} ${active ? "bg-accent-dim text-accent" : "text-text hover:bg-bg-hover"}`;
}

const tabClass = (active: boolean) =>
  `flex flex-1 flex-col items-center gap-0.5 px-0.5 py-1.5 font-display text-[10px] font-medium tracking-wide whitespace-nowrap transition-colors ${
    active ? "text-accent" : "text-text-muted"
  }`;

export function BottomTabs({ flags }: { flags: NavFlags }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { mobileTabs, more, moreOwner } = navItemsFor(flags);

  const accountActive = isNavItemActive(pathname, "/account");
  const moreActive = accountActive || more.some((item) => isNavItemActive(pathname, item.href));

  function SheetRow({ item }: { item: NavItem }) {
    const active = isNavItemActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={() => setMoreOpen(false)}
        aria-current={active ? "page" : undefined}
        className={sheetRowClass(active, moreOwner.includes(item))}
      >
        <Icon size={20} aria-hidden="true" />
        {item.label}
      </Link>
    );
  }

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] md:hidden"
        />
      )}

      {moreOpen && (
        <div
          role="menu"
          aria-label="More"
          className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-50 flex flex-col gap-1 rounded-2xl border border-border bg-bg-elevated-2 p-2 shadow-lg shadow-black/50 md:hidden"
        >
          {more.map((item) => (
            <SheetRow key={item.href} item={item} />
          ))}
          {more.length > 0 && <div className="my-1 sprocket-rule" aria-hidden="true" />}
          {/* Account lives here on mobile (household, passkeys, Sign out) —
              the top bar only has room for the avatar. */}
          <Link
            href="/account"
            onClick={() => setMoreOpen(false)}
            aria-current={accountActive ? "page" : undefined}
            className={sheetRowClass(accountActive, false)}
          >
            <UserRound size={20} aria-hidden="true" />
            Account
          </Link>
        </div>
      )}

      {/* Same glass recipe as the desktop sidebar (sidebar.tsx). */}
      <nav
        className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-40 rounded-2xl border border-border bg-bg-elevated/90 shadow-lg shadow-black/40 backdrop-blur-md md:hidden"
        aria-label="Primary"
      >
        <div className="flex items-stretch justify-around px-1 py-1">
          {mobileTabs.map((item) => {
            const active = isNavItemActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMoreOpen(false)}
                aria-current={active ? "page" : undefined}
                className={tabClass(active)}
              >
                <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
                {item.tabLabel}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            className={tabClass(moreActive || moreOpen)}
          >
            <Ellipsis size={20} strokeWidth={moreActive || moreOpen ? 2.5 : 2} aria-hidden="true" />
            More
          </button>
        </div>
      </nav>
    </>
  );
}
