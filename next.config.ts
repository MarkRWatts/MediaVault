import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  // No floating Next.js dev-tools button in the corner of dev sessions.
  devIndicators: false,
};

export default nextConfig;
