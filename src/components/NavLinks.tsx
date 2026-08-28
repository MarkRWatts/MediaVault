"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Movies" },
  { href: "/shows", label: "Shows" },
  { href: "/music", label: "Music" },
  { href: "/collections", label: "Collections" },
  { href: "/scan", label: "Scan" },
  { href: "/report", label: "Report" },
] as const;

export default function NavLinks({ signedIn = false }: { signedIn?: boolean }) {
  const pathname = usePathname();
  // /household is only reachable (and useful) once signed in — proxy.ts
  // would bounce a signed-out visit to /signin anyway, so there's no point
  // showing a dead link.
  const links = signedIn ? [...LINKS, { href: "/household", label: "Household" }] : LINKS;

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
