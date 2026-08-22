import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import AdminStrip from "@/components/AdminStrip";

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:gap-x-6 sm:px-6 lg:flex-nowrap lg:py-3">
        <Link href="/" className="shrink-0" aria-label="MediaVault — home">
          {/* Logo PNG is transparent, so it sits flush against --bg. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="MediaVault" className="h-8 w-auto sm:h-10" />
        </Link>
        <NavLinks />
        {/* Below lg there isn't room for the admin strip on the same row as
            the logo + links, so it wraps to its own full-width row (flex-wrap
            above gives it nowhere else to go) and right-aligns its content.
            At lg+ it's pinned to the end of the single row, unchanged. */}
        <div className="w-full lg:ml-auto lg:w-auto">
          <AdminStrip />
        </div>
      </div>
      <div className="sprocket-rule" />
    </header>
  );
}
