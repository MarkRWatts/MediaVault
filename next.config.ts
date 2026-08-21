import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  // No floating Next.js dev-tools button in the corner of dev sessions.
  devIndicators: false,
  images: {
    // localPatterns is an allow-list: every local next/image source must be
    // listed once any pattern exists. Covers carry a ?v= cache-buster (their
    // bytes can change under a fixed URL — see CoverImage), so that pattern
    // omits `search`; posters are immutable TMDB paths with no query.
    localPatterns: [
      { pathname: "/api/cover/**" },
      { pathname: "/api/poster/**", search: "" },
    ],
  },
};

export default nextConfig;
