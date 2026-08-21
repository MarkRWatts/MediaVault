"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Movies" },
  { href: "/shows", label: "Shows" },
  { href: "/music", label: "Music" },
  { href: "/collections", label: "Collections" },
  { href: "/report", label: "Report" },
] as const;

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium tracking-wide transition-colors ${
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
