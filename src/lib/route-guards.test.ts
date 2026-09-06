// Regression guard for the authorization floor.
//
// src/proxy.ts's cookie check is deliberately cheap and is NOT a session
// check (see src/lib/session-cookie.ts). The app once had a dozen routes
// and pages that relied on it alone — reachable with a forged cookie. This
// test walks every route handler and page under src/app and asserts each
// one names a real guard, so a new file can't quietly regress that. It is a
// source-text check, not a runtime one: the point is to make forgetting
// loud, not to prove the guard is called before every branch (code review
// still owns that).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = path.resolve(import.meta.dirname, "../app");

/** Every file under APP_DIR whose basename is `name`, absolute paths. */
function findFiles(name: string): string[] {
  return readdirSync(APP_DIR, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === name)
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

// A file passes if it contains at least one of these. Route handlers
// return a NextResponse; pages redirect; both live in require-member.ts
// except the two places that legitimately read the session directly.
const ROUTE_GUARDS = [
  "requireMemberOrResponse(",
  "requireOwnerOrResponse(",
  "requireAdultAccessOrResponse(",
  // The Jellyfin playback routes delegate wholesale to src/lib/jf-routes.ts,
  // whose three handlers each start with currentViewer() (auth.api.getSession
  // + user lookup) before touching anything.
  "jfSession(",
  "jfProxy(",
  "jfStop(",
  "auth.api.getSession(", // the progress routes: per-user rows, session is the scope
];
const PAGE_GUARDS = [
  "requireMemberOrRedirect(",
  "requireOwnerOrRedirect(",
  "requireAdultAccessOrRedirect(",
];

// Routes that are public ON PURPOSE. Keep this list short and explained.
const PUBLIC_ROUTES = new Set([
  "api/auth/[...all]/route.ts", // BetterAuth itself — sign-in has to be reachable signed-out
  "api/poster/[...path]/route.ts", // next/image optimizer fetches server-side without cookies; see the route's header comment
  "api/cover/[albumId]/route.ts", // same
  "api/physical-cover/[copyId]/route.ts", // same
]);
// Pages that manage their own session handling (pre-auth flow, or
// signed-in-but-no-household states that requireMemberOrRedirect would
// bounce away from).
const SELF_MANAGED_PAGES = new Set([
  "signin/page.tsx",
  "signup/page.tsx",
  "invite/[token]/page.tsx",
  "onboarding/page.tsx",
  "consent/page.tsx",
]);

function rel(p: string): string {
  return path.relative(APP_DIR, p).split(path.sep).join("/");
}

describe("every API route handler names a real session guard", () => {
  const routes = findFiles("route.ts");
  it("found the route files", () => {
    expect(routes.length).toBeGreaterThan(40);
  });
  for (const file of routes) {
    const name = rel(file);
    if (PUBLIC_ROUTES.has(name)) continue;
    it(name, () => {
      const src = readFileSync(file, "utf8");
      expect(ROUTE_GUARDS.some((g) => src.includes(g)), `${name} has no session guard`).toBe(true);
    });
  }
});

describe("every page names a real session guard (or is a known pre-auth page)", () => {
  const pages = findFiles("page.tsx");
  it("found the page files", () => {
    expect(pages.length).toBeGreaterThan(15);
  });
  for (const file of pages) {
    const name = rel(file);
    if (SELF_MANAGED_PAGES.has(name)) continue;
    it(name, () => {
      const src = readFileSync(file, "utf8");
      expect(PAGE_GUARDS.some((g) => src.includes(g)), `${name} has no session guard`).toBe(true);
    });
  }
});

describe("the public lists only name files that exist", () => {
  for (const name of [...PUBLIC_ROUTES, ...SELF_MANAGED_PAGES]) {
    it(name, () => {
      expect(() => readFileSync(path.join(APP_DIR, name))).not.toThrow();
    });
  }
});
