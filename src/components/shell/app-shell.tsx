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
import { TopNav } from "./top-nav";
import { Sidebar } from "./sidebar";
import { BottomTabs } from "./bottom-tabs";

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
  // sidebarCollapsed is read server-side so the sidebar's client useState
  // starts at the right width with no hydration flash.
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      image: true,
      isAppOwner: true,
      adultLibraryAccess: true,
      sidebarCollapsed: true,
    },
  });
  const shellUser: ShellUser = { name: user.name, email: user.email, image: user.image };
  const flags = { isOwner: user.isAppOwner, hasAdultAccess: user.adultLibraryAccess };

  return (
    <>
      <TopNav user={shellUser} />
      <Sidebar user={shellUser} flags={flags} initialCollapsed={user.sidebarCollapsed} />
      {/* md:pl clears the floating sidebar (its width plus the 1rem inset
          on each side, the left one growing with the safe-area inset on a
          notched phone in landscape); transitions in step with the
          sidebar's own width animation so content reflows smoothly on
          collapse/expand. pb-28 clears the floating mobile tab bar: its
          bottom offset (0.75rem + safe-area inset) plus its ~3.5rem
          height. flex/flex-col keeps the library pages' flex-1 fill
          working exactly as it did under the old layout's <main>. */}
      <main className="flex flex-1 flex-col pb-28 transition-[padding-left] motion-reduce:transition-none md:pb-0 md:pl-[calc(var(--sidebar-w)+1rem+max(1rem,env(safe-area-inset-left)))]">
        {children}
      </main>
      <BottomTabs flags={flags} />
    </>
  );
}
