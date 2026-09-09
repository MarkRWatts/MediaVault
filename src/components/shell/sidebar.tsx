"use client";

// Desktop chrome: a floating glass rail, fixed to the left edge (md+ —
// top-nav.tsx and bottom-tabs.tsx cover mobile). Needs usePathname for
// active-state + local state for the collapse toggle, hence the client
// boundary. Ported from template-app (structure) + TrainTracker (safe-area
// inset) + Jingle Jotter (the tinted owner-only group), restyled to
// MediaVault's tokens.
//
// Responsive/collapse behaviour is deliberately CSS-only, not JS-branched:
// this component doesn't know its own breakpoint at render time (SSR can't
// see the viewport), so instead of computing "is this collapsed?" in JS it
// stamps the live collapse state onto the <nav> itself (`data-collapsed`)
// and lets every row's classes react to that plus the `lg` breakpoint via
// Tailwind's `group-data-[collapsed=false]:` variant. Below `lg` the plain
// (non-`lg:`) classes win regardless of `data-collapsed` — that's what
// forces the rail collapsed under that breakpoint. The same `data-collapsed`
// attribute (plus `id="app-sidebar"`) is also how globals.css's
// `body:has(#app-sidebar...)` rule derives --sidebar-w for <main>, which
// isn't a descendant of this component — see the "Sidebar offset" block
// there.

import Link from "next/link";
import { useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { setSidebarCollapsed } from "@/app/actions/prefs";
import { UserAvatar } from "@/components/UserAvatar";
import type { ShellUser } from "./app-shell";
import { isNavItemActive, navItemsFor, type NavFlags, type NavItem } from "./nav-items";

/** Shared row classes: centered icon-only by default (mobile-first, and
 *  the below-`lg` forced rail), left-aligned with a visible label once
 *  `lg:group-data-[collapsed=false]` — i.e. expanded at `lg`+ — kicks in.
 *  `title`/`aria-label` on the link itself carry the accessible name
 *  whenever the visible label is CSS-hidden. */
const rowBase =
  "flex items-center justify-center gap-3 rounded-lg px-3 py-2.5 font-display text-[0.98rem] font-medium tracking-wide transition-colors lg:group-data-[collapsed=false]:justify-start lg:group-data-[collapsed=false]:px-4";

function rowClass(active: boolean) {
  return `${rowBase} ${active ? "bg-accent-dim text-accent" : "text-text-muted hover:bg-bg-hover hover:text-text"}`;
}

/** Owner-only rows (Scan, Report, Admin) get the Blu-ray blue instead of
 *  the amber accent, so they read as admin-only at a glance. */
function ownerRowClass(active: boolean) {
  return `${rowBase} ${active ? "bg-blu-bg text-blu" : "text-blu/70 hover:bg-blu-bg hover:text-blu"}`;
}

const labelClass = "hidden truncate lg:group-data-[collapsed=false]:inline";

function NavRow({ item, active, className }: { item: NavItem; active: boolean; className: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.label}
      aria-label={item.label}
      className={className}
    >
      <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden="true" className="shrink-0" />
      <span className={labelClass}>{item.label}</span>
    </Link>
  );
}

export function Sidebar({
  user,
  flags,
  initialCollapsed,
}: {
  user: ShellUser;
  flags: NavFlags;
  initialCollapsed: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [, startTransition] = useTransition();
  const { primary, owner } = navItemsFor(flags);

  // Flip instantly for the click that triggered it; persist in the
  // background. The stored value only matters on the next full load, so
  // there's no need to revalidate anything on success.
  function applyCollapsed(next: boolean) {
    setCollapsed(next);
    startTransition(() => {
      setSidebarCollapsed(next).catch(() => {
        // Best-effort persistence; a failed write just means next load
        // falls back to the last-saved state. Nothing to surface here.
      });
    });
  }

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <nav
      id="app-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Primary sidebar"
      // group: scopes every `group-data-[collapsed=…]` row below to this
      // element's own data-collapsed, not some outer ancestor's.
      // overflow-hidden/y-auto: clips label text mid-transition instead
      // of letting it poke past the still-narrow rail, and lets the list
      // scroll on short viewports without growing past top-4/bottom-4.
      className="group fixed top-4 bottom-4 left-[max(1rem,env(safe-area-inset-left))] z-30 hidden w-[var(--sidebar-w)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated/85 shadow-lg shadow-black/40 backdrop-blur-md transition-[width] motion-reduce:transition-none md:flex"
    >
      <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 py-4">
        {/* Brand: the square app icon always; the wordmark only when
            expanded. Plain <img> — see next.config.ts for why not
            next/image. Both files are in proxy.ts's public matcher. */}
        <Link
          href="/"
          aria-label="MediaVault — home"
          className="mb-2 flex shrink-0 items-center justify-center gap-2 px-1 pb-3 lg:group-data-[collapsed=false]:justify-start"
        >
          <img src="/icon.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-lg" />
          <img
            src="/logo.png"
            alt="MediaVault"
            className={`h-7 w-auto shrink-0 ${labelClass}`}
          />
        </Link>

        {/* Collapse toggle: only meaningful at lg+ (below that the rail
            is forced regardless), so hidden entirely below lg. */}
        <button
          type="button"
          onClick={() => applyCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="mb-2 hidden shrink-0 items-center justify-center self-center rounded-full p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text lg:flex lg:group-data-[collapsed=false]:self-end"
        >
          <ToggleIcon size={18} aria-hidden="true" />
        </button>

        <div className="flex flex-col gap-1">
          {primary.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              active={isNavItemActive(pathname, item.href)}
              className={rowClass(isNavItemActive(pathname, item.href))}
            />
          ))}
        </div>

        {owner.length > 0 && (
          <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
            {owner.map((item) => (
              <NavRow
                key={item.href}
                item={item}
                active={isNavItemActive(pathname, item.href)}
                className={ownerRowClass(isNavItemActive(pathname, item.href))}
              />
            ))}
          </div>
        )}

        {/* Bottom-up: who's signed in sits at the very bottom, linking to
            /account (identity, household, passkeys, Sign out). */}
        <div className="mt-auto flex flex-col gap-1 pt-3">
          <Link
            href="/account"
            aria-current={isNavItemActive(pathname, "/account") ? "page" : undefined}
            title={user.name || user.email || "Account"}
            aria-label="Account"
            className="flex items-center justify-center gap-2 rounded-full px-1.5 py-1.5 transition-colors hover:bg-bg-hover lg:group-data-[collapsed=false]:justify-start"
          >
            <UserAvatar {...user} size={32} className="shrink-0" />
            <span className={`max-w-[9rem] text-sm font-medium text-text ${labelClass}`}>
              {user.name || user.email}
            </span>
          </Link>
        </div>
      </div>
    </nav>
  );
}
