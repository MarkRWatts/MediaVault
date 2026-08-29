"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Movies" },
  { href: "/shows", label: "Shows" },
  { href: "/music", label: "Music" },
  { href: "/collections", label: "Collections" },
] as const;

// Owner-only per HOUSEHOLDS_PLAN.md's "Auth & gating" rule — scan/enrich
// pipeline and the collection-bookkeeping report aren't things a non-owner
// member can do anything with (every action behind them 403s for a
// member), so there's no point showing the link. This is a UX nicety only:
// the actual boundary is requireOwnerOrResponse() on the routes/pages
// themselves.
const OWNER_LINKS = [
  { href: "/scan", label: "Scan" },
  { href: "/report", label: "Report" },
] as const;

export default function NavLinks({
  signedIn = false,
  isOwner = false,
  hasAdultAccess = false,
}: {
  signedIn?: boolean;
  isOwner?: boolean;
  hasAdultAccess?: boolean;
}) {
  const pathname = usePathname();
  // /stats and /account are only reachable (and useful) once signed in —
  // proxy.ts would bounce a signed-out visit to /signin anyway, so there's
  // no point showing dead links. /stats is personal watch history (Phase 9
  // of HOUSEHOLDS_PLAN.md's "Watch history & stats") — any signed-in member,
  // not owner-only, unlike the OWNER_LINKS above. /account is the unified
  // account/household settings page (see HOUSEHOLDS_PLAN.md) — identity +
  // household management in one place. /adult is gated on the self-service
  // opt-in (see /account), not signedIn/isOwner — same UX-nicety-only
  // posture as OWNER_LINKS.
  const links = [
    ...LINKS,
    ...(hasAdultAccess ? [{ href: "/adult", label: "Adult" }] : []),
    ...(isOwner ? OWNER_LINKS : []),
    ...(signedIn ? [{ href: "/stats", label: "Stats" }, { href: "/account", label: "Account" }] : []),
  ];

  return (
    // Six-plus links no longer fit a narrow phone's width alongside the
    // logo — rather than let them get clipped/squashed off-screen, the row
    // scrolls horizontally (same pattern FilmShelf already uses), with
    // shrink-0 so an individual link truncates by scrolling into view, not
    // by shrinking.
    <nav aria-label="Primary" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {links.map((link) => {
        const active =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium tracking-wide transition-colors ${
              active
                ? "text-accent bg-accent-dim"
                : "text-text-muted hover:text-text hover:bg-bg-hover"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
