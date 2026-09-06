import type { NextConfig } from "next";

// Content Security Policy. Inputs this is sized for (verified in the code,
// keep in step when adding a dependency):
//   - every image is same-origin (/api/poster, /api/cover, /logo.png …) —
//     no remotePatterns, no third-party <img>; next/image needs data:/blob:
//   - fonts are self-hosted via next/font (no fonts.googleapis.com at runtime)
//   - hls.js plays through MediaSource -> media-src blob:, and runs its
//     demuxer in a Worker created from a blob -> worker-src blob:
//   - the barcode scanner (@zxing/browser) uses the camera -> see
//     Permissions-Policy; it needs nothing extra in the CSP
//   - Next's App Router emits inline bootstrap scripts, so script-src needs
//     'unsafe-inline' unless a per-request nonce is threaded through
//     proxy.ts; no 'unsafe-eval' is needed in a production build
//   - passkeys (WebAuthn) need nothing extra
// Shipped as Report-Only first so a mistake shows up in the browser console
// rather than as a broken page; once a few days pass without violations,
// rename the header to Content-Security-Policy to enforce it.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  // Two years, subdomains, preload-eligible. Browsers ignore it over plain
  // http (local dev), and Cloudflare can set it too — harmless to double up.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing here is meant to be framed (the OIDC consent page included —
  // jellyfin-plugin-sso redirects, it doesn't embed).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), " +
      "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  },
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  // No floating Next.js dev-tools button in the corner of dev sessions.
  devIndicators: false,
  // Don't advertise the framework in every response.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  images: {
    // No next/image anywhere: its optimizer fetches sources server-side
    // with none of the browser's cookies, which forced the poster/cover
    // routes to be public. Artwork is served pre-sized from the cache
    // (TMDB's w342/w780, 300-600px covers) through plain <img> tags behind
    // the session check instead, and the optimizer endpoint is switched off.
    unoptimized: true,
  },
};

export default nextConfig;
