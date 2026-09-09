// Root shell: decides whether to render nav chrome at all, then renders it.
// Signed-out pages (/signin, /signup, /invite/[token]), signed-in-but-no-
// household-yet pages (/onboarding, /invite/[token] again) and the OIDC
// consent card (/consent, see CHROMELESS_PATHS) get bare children; every
// other page gets the floating sidebar (desktop) or top bar + bottom tabs
// (mobile). Ported from template-app's components/shell/app-shell.tsx with
// TrainTracker's safe-area inset on <main>.
//
// This runs inside the root layout, so it's the one place that has to
// guard against "no session"/"no household" itself rather than relying on
// each page's own auth-or-redirect check. Deciding visibility off the real
// session (rather than the path) means a page never shows a nav whose
// links would all bounce via requireMemberOrRedirect().

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isChromelessPath } from "@/lib/public-paths";
import { PlayerProvider } from "@/components/player/PlayerProvider";
import { TopNav } from "./top-nav";
import { Sidebar } from "./sidebar";
import { BottomTabs } from "./bottom-tabs";
import { Rail } from "./rail";
import { MobilePlayerBar } from "./mobile-player-bar";

export type ShellUser = {
  name: string | null;
  email: string | null;
  image: string | null;
};

export async function AppShell({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  // x-pathname is set by proxy.ts — Server Components have no other way to
  // read the current path in a shared root layout. Missing header (a
  // harness rendering the layout without proxy.ts) just means "not
  // chromeless", which is the safe default: the page's own session check
  // still governs access.
  const pathname = requestHeaders.get("x-pathname") ?? "";
  if (isChromelessPath(pathname)) {
    return <>{children}</>;
  }

  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    return <>{children}</>;
  }

  // A signed-in user with no household yet is mid-onboarding (or landed on
  // an invite link) — nav chrome pointing at pages that need a household
  // would just bounce them straight back, so skip it entirely.
  const member = await prisma.member.findFirst({ where: { userId: session.user.id } });
  if (!member) {
    return <>{children}</>;
  }

  // One read for everything the chrome needs. isAppOwner / adultLibraryAccess
  // only decide which rows render — a UX nicety, not the security boundary
  // (that's requireOwnerOrRedirect / requireAdultAccessOrRedirect on the
  // pages and routes themselves; see src/lib/require-member.ts).
  // sidebarCollapsed/railCollapsed are read server-side so the sidebar's
  // and rail's client useState start at the right width with no hydration
  // flash.
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      image: true,
      isAppOwner: true,
      adultLibraryAccess: true,
      sidebarCollapsed: true,
      railCollapsed: true,
    },
  });
  const shellUser: ShellUser = { name: user.name, email: user.email, image: user.image };
  const flags = { isOwner: user.isAppOwner, hasAdultAccess: user.adultLibraryAccess };

  // PlayerProvider owns the one gapless music engine for the life of the
  // root layout (see components/player/PlayerProvider.tsx) — it has to
  // wrap everything that can read/control it: <main>'s pages (play
  // buttons, track menus), the Rail's Now Playing card, and the mobile
  // strip/sheet. Only mounted on this branch — chromeless pages have
  // nothing that reads usePlayer().
  return (
    <PlayerProvider>
      <TopNav user={shellUser} />
      <Sidebar user={shellUser} flags={flags} initialCollapsed={user.sidebarCollapsed} />
      {/* md:pl clears the floating sidebar (its width plus the 1rem inset
          on each side, the left one growing with the safe-area inset on a
          notched phone in landscape); md:pr does the same for the rail on
          the right (see rail.tsx and globals.css's "Rail offset" block —
          --rail-w is 0 whenever the rail isn't mounted). transition-
          [padding] (not just padding-left) now that both sides animate,
          in step with the sidebar's/rail's own width transitions so
          content reflows smoothly on collapse/expand. pb-[calc(7rem+
          var(--player-bar-h))] clears the floating mobile tab bar (0.75rem
          bottom offset + safe-area inset + ~3.5rem height, same as
          before) plus the mobile now-playing strip stacked above it when
          something's queued. flex/flex-col keeps the library pages'
          flex-1 fill working exactly as it did under the old layout's
          <main>. @container makes <main> the size container every page's
          grid ladder measures (`@xl:`, `@5xl:` … variants), so column
          counts follow the width actually available beside the sidebar
          (and rail) rather than the viewport — see src/lib/card-grid.ts.
          Chrome/Safari keep position:fixed descendants (VideoPlayer,
          confirm dialogs) viewport-relative inside an inline-size
          container. */}
      <main className="@container flex flex-1 flex-col pb-[calc(7rem+var(--player-bar-h))] transition-[padding] motion-reduce:transition-none md:pb-0 md:pl-[calc(var(--sidebar-w)+1rem+max(1rem,env(safe-area-inset-left)))] md:pr-[calc(var(--rail-w)+1rem+max(1rem,env(safe-area-inset-right)))]">
        {children}
      </main>
      <Rail initialCollapsed={user.railCollapsed} />
      <MobilePlayerBar />
      <BottomTabs flags={flags} />
    </PlayerProvider>
  );
}
