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

// ---------------------------------------------------------------------------
// The age-rating gate (src/lib/age-rating.ts), same regression posture as
// the session guards above: a source-text check that makes forgetting loud.
//
// Two separate obligations, because they fail differently. A listing that
// forgets the limit shows a child an 18's poster and title; a playback route
// that forgets it hands over the bytes to anyone who knows the id. Both are
// easy to reintroduce by copying a neighbouring file.
// ---------------------------------------------------------------------------

/** Everything under these directories streams or describes one media file by
 *  id, so every handler in them must age-gate — either directly (ageGate /
 *  ageGateForUser) or by delegating wholesale to src/lib/jf-routes.ts, whose
 *  jfSession/jfProxy do it in both engine branches (jfStop takes a
 *  playSessionId, not a media id — see its comment there). */
const PLAYBACK_DIRS = ["api/video/", "api/tv-video/"];
const AGE_GATES = ["ageGate(", "ageGateForUser(", "jfSession(", "jfProxy(", "jfStop("];

/** Reading the library means calling into src/lib/queries.ts, whose
 *  content functions all take an AgeLimit — so naming it is the check. */
const QUERIES_IMPORT = 'from "@/lib/queries"';
const NAMES_LIMIT = ["ageLimit", '"unrestricted"'];

// Library readers that legitimately don't take a viewer's limit. Keep this
// list short and explained — each entry is a place a restricted member's
// data could leak if the reasoning ever stops holding.
const UNGATED_LIBRARY_READERS = new Set([
  // Owner-only pages (requireOwnerOrRedirect). An age restriction can only
  // be set on a role="member" row (setMemberDateOfBirth), and these are
  // gated on User.isAppOwner besides — a restricted member can't reach them.
  "report/page.tsx",
  "scan/page.tsx",
  // Per-user watch history: every row in it is something this person
  // actually watched, which the playback gate already governs. Filtering it
  // again would only hide their own past from them.
  "stats/page.tsx",
]);

describe("every playback route age-gates the media it serves", () => {
  const routes = findFiles("route.ts").filter((f) => PLAYBACK_DIRS.some((d) => rel(f).startsWith(d)));
  it("found the playback routes", () => {
    expect(routes.length).toBeGreaterThan(8);
  });
  for (const file of routes) {
    const name = rel(file);
    it(name, () => {
      const src = readFileSync(file, "utf8");
      expect(AGE_GATES.some((g) => src.includes(g)), `${name} has no age gate`).toBe(true);
    });
  }
});

/** The UHD block (src/lib/uhd-gate.ts) is film-only — a Version has a
 *  format, an EpisodeFile doesn't — so it's api/video/ alone. Same posture
 *  as the age gate above: jfStop takes a playSessionId rather than a media
 *  id, and the other two jf handlers gate inside jf-routes.ts. */
const UHD_GATES = ["uhdGate(", "jfSession(", "jfProxy(", "jfStop("];

describe("every film playback route gates UltraHD", () => {
  const routes = findFiles("route.ts").filter((f) => rel(f).startsWith("api/video/"));
  it("found the film playback routes", () => {
    expect(routes.length).toBeGreaterThan(5);
  });
  for (const file of routes) {
    const name = rel(file);
    it(name, () => {
      const src = readFileSync(file, "utf8");
      expect(UHD_GATES.some((g) => src.includes(g)), `${name} has no UHD gate`).toBe(true);
    });
  }
});

describe("every library reader names the viewer's age limit", () => {
  const files = [...findFiles("route.ts"), ...findFiles("page.tsx")].filter((f) =>
    readFileSync(f, "utf8").includes(QUERIES_IMPORT),
  );
  it("found the library readers", () => {
    expect(files.length).toBeGreaterThan(8);
  });
  for (const file of files) {
    const name = rel(file);
    if (UNGATED_LIBRARY_READERS.has(name)) continue;
    it(name, () => {
      const src = readFileSync(file, "utf8");
      expect(NAMES_LIMIT.some((g) => src.includes(g)), `${name} reads the library without an age limit`).toBe(true);
    });
  }
});

describe("the public lists only name files that exist", () => {
  for (const name of [...PUBLIC_ROUTES, ...SELF_MANAGED_PAGES, ...UNGATED_LIBRARY_READERS]) {
    it(name, () => {
      expect(() => readFileSync(path.join(APP_DIR, name))).not.toThrow();
    });
  }
});
