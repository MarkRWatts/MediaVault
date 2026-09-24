"use client";

// Mobile top bar: brand mark and the signed-in person's avatar, which opens
// the account menu — Collections, History, Adult and the owner's tools
// (everything that isn't one of the five tabs, see nav-items.ts) and
// Account itself. Mobile-only (md:hidden): Sidebar carries the same rows
// from md up. Keeps the sprocket rule as its bottom edge, as the old header
// did.
//
// Not drawn at all on a film page, which has its own floating Back over
// the artwork instead of a logo bar (FILM_PAGE_PLAN.md "Top"). Decided off
// usePathname rather than in AppShell because the root layout doesn't
// re-render on a client-side navigation.

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";
import { UserAvatar } from "@/components/UserAvatar";
import type { ShellUser } from "./app-shell";
import { isNavItemActive, navItemsFor, type NavFlags, type NavItem } from "./nav-items";

/** Pages that draw their own top controls instead of the logo bar. */
export function hidesTopNav(pathname: string): boolean {
  return pathname.startsWith("/film/");
}

const menuRow =
  "flex items-center gap-3 rounded-lg px-4 py-3 font-display text-sm font-medium tracking-wide transition-colors";

function menuRowClass(active: boolean, owner: boolean) {
  // Danger red for owner rows, matching the sidebar's ownerRowClass — same
  // --missing token destructive actions use elsewhere.
  if (owner) return `${menuRow} ${active ? "bg-missing-bg text-missing" : "text-missing/70 hover:bg-missing-bg hover:text-missing"}`;
  return `${menuRow} ${active ? "bg-accent-dim text-accent" : "text-text hover:bg-bg-hover"}`;
}

export function TopNav({ user, flags }: { user: ShellUser; flags: NavFlags }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  if (hidesTopNav(pathname)) return null;

  const { extras, owner } = navItemsFor(flags);
  const accountActive = isNavItemActive(pathname, "/account");

  function MenuRow({ item, isOwner }: { item: NavItem; isOwner: boolean }) {
    const active = isNavItemActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        role="menuitem"
        onClick={() => setMenuOpen(false)}
        aria-current={active ? "page" : undefined}
        className={menuRowClass(active, isOwner)}
      >
        <Icon size={20} aria-hidden="true" />
        {item.label}
      </Link>
    );
  }

  return (
    <>
      <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur md:hidden">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Link href="/" className="shrink-0" aria-label="MediaVault — home">
            <img src="/logo.png" alt="MediaVault" className="h-8 w-auto" />
          </Link>
          <div className="flex flex-1 justify-end">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Account menu"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="rounded-full"
            >
              <UserAvatar {...user} size={32} />
            </button>
          </div>
        </div>
        <div className="sprocket-rule" />
      </header>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] md:hidden"
          />
          <div
            role="menu"
            aria-label="Account menu"
            className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+3.75rem)] z-50 flex flex-col gap-1 rounded-2xl border border-border bg-bg-elevated-2 p-2 shadow-lg shadow-black/50 md:hidden"
          >
            {extras.map((item) => (
              <MenuRow key={item.href} item={item} isOwner={false} />
            ))}
            {/* Owner rows (Scan, Report, Admin) get their own divider, same
                as the sidebar's bottom owner group — see menuRowClass. */}
            {owner.length > 0 && (
              <>
                <div className="my-1 sprocket-rule" aria-hidden="true" />
                {owner.map((item) => (
                  <MenuRow key={item.href} item={item} isOwner />
                ))}
              </>
            )}
            <div className="my-1 sprocket-rule" aria-hidden="true" />
            {/* Household, passkeys, Sign out. */}
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              aria-current={accountActive ? "page" : undefined}
              className={menuRowClass(accountActive, false)}
            >
              <UserRound size={20} aria-hidden="true" />
              Account
            </Link>
          </div>
        </>
      )}
    </>
  );
}
