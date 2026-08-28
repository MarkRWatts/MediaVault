import Link from "next/link";
import { headers } from "next/headers";
import NavLinks from "@/components/NavLinks";
import AdminStrip from "@/components/AdminStrip";
import SignOutButton from "@/components/SignOutButton";
import { auth } from "@/lib/auth";

export default async function Nav() {
  // Real (database-validated) session check — this only decides whether to
  // render the sign-out control, not authorization (that's proxy.ts's
  // cookie gate + each page's own getSession()/requireMember() call), so a
  // per-request DB hit here is fine.
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <header className="sticky top-0 z-50 bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:gap-x-6 sm:px-6 lg:flex-nowrap lg:py-3">
        <Link href="/" className="shrink-0" aria-label="MediaVault — home">
          {/* Logo PNG is transparent, so it sits flush against --bg. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="MediaVault" className="h-8 w-auto sm:h-10" />
        </Link>
        <NavLinks signedIn={Boolean(session?.user)} />
        {/* Below lg there isn't room for the admin strip on the same row as
            the logo + links, so it wraps to its own full-width row (flex-wrap
            above gives it nowhere else to go) and right-aligns its content.
            At lg+ it's pinned to the end of the single row, unchanged. */}
        <div className="flex w-full items-center justify-end gap-3 lg:ml-auto lg:w-auto">
          <AdminStrip />
          {session?.user && <SignOutButton />}
        </div>
      </div>
      <div className="sprocket-rule" />
    </header>
  );
}
