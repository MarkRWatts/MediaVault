import type { Metadata } from "next";
import { headers } from "next/headers";
import { Fredoka, JetBrains_Mono } from "next/font/google";
import Nav from "@/components/Nav";
import { isPreAuthPath } from "@/lib/public-paths";
import "./globals.css";

// Used for both --font-display and --font-sans (see globals.css) — one
// variable-weight family, differentiated by size/tracking/weight utility
// classes rather than by a separate display face.
const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MediaVault",
  description: "A personal index of a DVD / Blu-ray and music collection.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // x-pathname is set by proxy.ts (Server Components have no other way to
  // read the current path in a shared root layout). Falls back to showing
  // Nav if the header is somehow missing — e.g. under a test harness that
  // renders this layout without going through proxy.ts first — since that's
  // the safer default (a signed-out visit to a real page just bounces via
  // proxy.ts regardless; the failure mode of concern is only the reverse).
  const pathname = (await headers()).get("x-pathname") ?? "";
  const showNav = !isPreAuthPath(pathname);

  return (
    <html
      lang="en"
      className={`${fredoka.variable} ${jbMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col antialiased">
        {showNav && <Nav />}
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
