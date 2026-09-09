import type { Metadata } from "next";
import { headers } from "next/headers";
import { Fredoka, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/shell/app-shell";
import { networkKind } from "@/lib/request-network";
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
  // "remote" when the page came in through the Cloudflare Tunnel — read by
  // VideoPlayer to default to the 720p rendition off the LAN (see
  // src/lib/request-network.ts).
  const network = networkKind(await headers());

  return (
    <html
      lang="en"
      data-network={network}
      className={`${fredoka.variable} ${jbMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col antialiased">
        {/* AppShell decides whether to render the sidebar / tab bar at all
            (no session, no household, or a chromeless card page → bare
            children) and owns <main>; see components/shell/app-shell.tsx. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
