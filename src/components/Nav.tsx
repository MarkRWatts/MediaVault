import Link from "next/link";
import { headers } from "next/headers";
import NavLinks from "@/components/NavLinks";
import SignOutButton from "@/components/SignOutButton";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function Nav() {
  // Real (database-validated) session check — this only decides whether to
  // render the sign-out control, not authorization (that's proxy.ts's
  // cookie gate + each page's own getSession()/requireMember() call), so a
  // per-request DB hit here is fine.
  const session = await auth.api.getSession({ headers: await headers() });

  // Owner-only nav links (Scan, Report) and the admin strip are hidden for
  // non-owners — a UX nice-to-have, not the security boundary (that's the
  // owner-only gate on the underlying API routes/pages, see
  // requireOwnerOrResponse). Checks User.isAppOwner, NOT Member.role —
  // these are app-wide product-owner tools, not household management, so
  // they must stay visible/hidden based on the same app-wide flag
  // regardless of who owns which household (see
  // src/lib/require-member.ts's Owner type doc comment). Doesn't
  // redirect/throw — Nav renders on every page, including ones reachable
  // while signed out (signin/signup/invite), so a signed-out visitor
  // should just see the non-owner nav, not an error.
  const user = session?.user
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { isAppOwner: true } })
    : null;
  const isOwner = user?.isAppOwner ?? false;

  return (
    <header className="sticky top-0 z-50 bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:gap-x-6 sm:px-6 lg:flex-nowrap lg:py-3">
        <Link href="/" className="shrink-0" aria-label="MediaVault — home">
          {/* Logo PNG is transparent, so it sits flush against --bg. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="MediaVault" className="h-8 w-auto sm:h-10" />
        </Link>
        <NavLinks signedIn={Boolean(session?.user)} isOwner={isOwner} />
        <div className="flex w-full items-center justify-end gap-3 lg:ml-auto lg:w-auto">
          {session?.user && <SignOutButton />}
        </div>
      </div>
      <div className="sprocket-rule" />
    </header>
  );
}
