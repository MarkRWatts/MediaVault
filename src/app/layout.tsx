import type { Metadata } from "next";
import { Bebas_Neue, Inter, JetBrains_Mono } from "next/font/google";
import Nav from "@/components/Nav";
import "./globals.css";

const bebas = Bebas_Neue({
  variable: "--font-bebas",
  weight: "400",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "filmDB",
  description: "A personal index of a DVD / Blu-ray collection.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bebas.variable} ${inter.variable} ${jbMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col antialiased">
        <Nav />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
