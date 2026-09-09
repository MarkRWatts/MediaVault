import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { PUBLIC_PATHS, PUBLIC_PATH_PREFIXES as PAGE_PUBLIC_PATH_PREFIXES } from "@/lib/public-paths";
import { verifySessionCookie } from "@/lib/session-cookie";

// Ported from jinglejotter.com's proxy.ts (this Next.js version renamed
// middleware.ts -> proxy.ts, exporting `proxy` instead of `middleware` — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Verified working under both `next dev` (Turbopack, the default) and
// `next build && next start` — an unauthenticated request to any
// non-public path 307s to /signin?callbackURL=... in both.
//
// PUBLIC_PATHS/PAGE_PUBLIC_PATH_PREFIXES (signin/signup/invite) come from a
// shared module also used by layout.tsx, so the two can't drift. The one
// API exception is proxy-only — it's not a page, so layout.tsx has no
// reason to know about it: /api/auth/ is BetterAuth's own routes, needed to
// sign in at all. Nothing else is reachable signed-out — the poster/cover
// routes used to be, for next/image's cookie-less server-side optimizer
// fetch; the app renders plain <img> tags now, so they're gated too.
const PUBLIC_PATH_PREFIXES = [...PAGE_PUBLIC_PATH_PREFIXES, "/api/auth/"];

// BetterAuth plugin HTTP endpoints this app never calls from a browser —
// every organization operation goes through server actions (which call
// auth.api.* in-process, not over HTTP, so this deny-list doesn't affect
// them). Left reachable, the plugin's own /organization/create and
// /invite-member let any bare session mint a household without an access
// code and vouch arbitrary emails into the web of trust; accept-invitation
// skips the one-household rule; update-member-role can hand out the
// plugin's hidden "admin" role. 404 rather than 403 so the surface simply
// isn't there.
const DENIED_AUTH_PREFIXES = ["/api/auth/organization/"];

// Cheap, DB-free gate (this runs on every request, including prefetches):
// the session cookie must exist AND carry a valid HMAC from this server's
// BETTER_AUTH_SECRET — see src/lib/session-cookie.ts. getSessionCookie is
// BetterAuth's own helper for locating the cookie: it knows the actual
// name/prefix (including the `__Secure-` variant used over https) for the
// installed version, rather than this file hardcoding a name that could
// drift out of sync with a future better-auth upgrade. It does NOT verify
// anything itself — an earlier version of this file treated its presence
// as "signed in", which any request could satisfy by sending a made-up
// cookie of that name.
//
// This is still not authorization: a revoked or expired session carries a
// valid signature. Real authorization happens via auth.api.getSession() in
// every page and route handler (src/lib/require-member.ts — enforced by
// src/lib/route-guards.test.ts), which checks the session against the
// database. This layer just means a forged cookie gets nobody past the
// front door, and unauthenticated traffic never reaches a handler.
//
// /api/* is deliberately IN scope here — video/audio/films are meant to
// require a signed-in household member, not be reachable by anyone who has
// the URL. The separate owner-only gate (requireOwnerOrResponse) still
// applies on top of this for the library-mutation routes.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (DENIED_AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const authenticated = await verifySessionCookie(getSessionCookie(request), process.env.BETTER_AUTH_SECRET);
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!isPublic && !authenticated) {
    // An unauthenticated fetch/video-element request to an API route should
    // get a plain 401, not a redirect to an HTML sign-in page it can't do
    // anything with.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "not signed in" }, { status: 401 });
    }
    const signInUrl = new URL("/signin", request.url);
    // Preserve where they were headed (e.g. an invite link reached while
    // signed out elsewhere) — app/signin/page.tsx validates this is a
    // same-origin path before ever redirecting to it.
    signInUrl.searchParams.set("callbackURL", pathname + request.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }
  // NOTE: no cookie-based redirect AWAY from /signin here. A stale or
  // foreign session cookie would pass the optimistic check but fail the
  // real getSession() call in the page, bouncing /signin -> / -> /signin
  // forever. The signed-in-already redirect lives in app/signin/page.tsx,
  // where auth.api.getSession() validates the session against the database.
  //
  // Forwarded as a request header (not a response header) so layout.tsx can
  // read the current pathname via headers() — Server Components have no
  // other way to know it in a shared root layout. Read by the app shell
  // (components/shell/app-shell.tsx) to skip the sidebar / tab bar on
  // signed-in card pages (isChromelessPath, src/lib/public-paths.ts);
  // signed-out pages need no path check there since the shell also hides
  // itself whenever there's no session.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Only the build's static chunks and the icons the sign-in page itself
// shows stay public; everything else — /api, the image routes, files under
// public/, even /_next/image (unused now that no next/image sources
// remain) — goes through the check.
export const config = {
  matcher: ["/((?!_next/static|favicon.ico|apple-icon.png|icon.png|logo.png).*)"],
};
