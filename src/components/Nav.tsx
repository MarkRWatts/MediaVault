import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import AdminStrip from "@/components/AdminStrip";

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0" aria-label="filmDB — home">
          {/* Logo PNG's ground is near-identical to --bg, so it sits flush. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="filmDB" className="h-10 w-auto" />
        </Link>
        <NavLinks />
        <div className="ml-auto">
          <AdminStrip />
        </div>
      </div>
      <div className="sprocket-rule" />
    </header>
  );
}
