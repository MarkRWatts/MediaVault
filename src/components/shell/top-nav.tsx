// Server component: brand mark and the signed-in person's avatar. Mobile-
// only (md:hidden) — Sidebar takes over the equivalent row plus page
// navigation from md up, and BottomTabs carries navigation on mobile
// instead. Keeps the sprocket rule as its bottom edge, as the old header
// did.

import Link from "next/link";
import { UserAvatar } from "@/components/UserAvatar";
import type { ShellUser } from "./app-shell";

export function TopNav({ user }: { user: ShellUser }) {
  return (
    <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur md:hidden">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Link href="/" className="shrink-0" aria-label="MediaVault — home">
          <img src="/logo.png" alt="MediaVault" className="h-8 w-auto" />
        </Link>
        <div className="flex flex-1 justify-end">
          <Link href="/account" aria-label="Account" className="rounded-full">
            <UserAvatar {...user} size={32} />
          </Link>
        </div>
      </div>
      <div className="sprocket-rule" />
    </header>
  );
}
