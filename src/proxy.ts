import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { PUBLIC_PATHS, PUBLIC_PATH_PREFIXES as PAGE_PUBLIC_PATH_PREFIXES } from "@/lib/public-paths";

// Ported from jinglejotter.com's proxy.ts (this Next.js version renamed
// middleware.ts -> proxy.ts, exporting `proxy` instead of `middleware` — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Verified working under both `next dev` (Turbopack, the default) and
// `next build && next start` — an unauthenticated request to any
// non-public path 307s to /signin?callbackURL=... in both.
//
// PUBLIC_PATHS/PAGE_PUBLIC_PATH_PREFIXES (signin/signup/invite) come from a
// shared module also used by layout.tsx, so the two can't drift. The API
// exceptions below are proxy-only — they're not pages, so layout.tsx has no
// reason to know about them.
// /api/auth/ is BetterAuth's own routes — needed to sign in at all.
// /api/poster/ and /api/cover/ are poster/cover art (not the actual video or
// audio content) — deliberately excluded because next/image's built-in
// optimizer fetches these SERVER-SIDE (via its own internal /_next/image
// round-trip) and that internal fetch carries none of the original
// browser's cookies, so gating them broke every optimized poster/cover
// image app-wide the moment /api was brought into scope below.
const PUBLIC_PATH_PREFIXES = [...PAGE_PUBLIC_PATH_PREFIXES, "/api/auth/", "/api/poster/", "/api/cover/"];

// Optimistic only — checks cookie presence, never hits the DB (this runs on
// every request, including prefetches, and must stay edge-safe — no Prisma
// adapter import here). getSessionCookie is BetterAuth's own helper for
// exactly this: it knows the actual cookie name/prefix (including the
// `__Secure-` variant used over https/production) for the installed
// version, rather than this file hardcoding a name that could drift out of
// sync with a future better-auth upgrade. Real authorization happens via
// auth.api.getSession() in server components/route handlers, which checks
// the session against the database.
//
// /api/* is deliberately IN scope here (unlike an earlier version of this
// file) — video/audio/poster/cover/films are meant to require *some*
// signed-in member, not be reachable by anyone who has the URL. The
// separate owner-only gate (requireOwnerOrResponse, Phase 5) still applies
// on top of this for the library-mutation routes; this layer is the floor
// every route sits on.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = Boolean(getSessionCookie(request));
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
  // other way to know it in a shared root layout. Used to skip rendering
  // <Nav /> on pre-auth pages (isPreAuthPath, src/lib/public-paths.ts):
  // showing the full app nav on /signin before anyone's signed in makes no
  // sense, and every link on it would just bounce back here anyway.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Static assets and icons stay public; everything else (including /api,
// aside from the /api/auth/ prefix excluded above) goes through the check.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|apple-icon.png|icon.png|logo.png).*)"],
};
