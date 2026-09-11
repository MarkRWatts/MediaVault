// Exercises src/proxy.ts's authentication gate directly against NextRequest
// objects, covering the bearer-header path added alongside the cookie for
// native clients (IOS_PLAN.md) — see src/lib/session-cookie.test.ts for the
// lower-level HMAC checks this relies on.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { serializeSignedCookie } from "better-call";
import { proxy } from "./proxy";

const SECRET = "test-secret-please-ignore-0123456789";
process.env.BETTER_AUTH_SECRET = SECRET;

/** The cookie VALUE exactly as better-call puts it on the wire, matching
 *  src/lib/session-cookie.test.ts's helper. */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const setCookie = await serializeSignedCookie("better-auth.session_token", value, secret, {});
  return setCookie.slice(setCookie.indexOf("=") + 1).split(";")[0];
}

describe("proxy", () => {
  it("401s an API route with no cookie and no bearer header", async () => {
    const request = new NextRequest("http://localhost/api/films");
    const res = await proxy(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not signed in" });
  });

  it("passes through an API route with a valid bearer header", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", SECRET);
    const request = new NextRequest("http://localhost/api/films", {
      headers: { authorization: `Bearer ${signed}` },
    });
    const res = await proxy(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    // The rewritten request carries x-pathname for layout.tsx, same as the
    // cookie path — NextResponse.next() surfaces it as this header.
    expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/api/films");
  });

  it("401s an API route with a tampered bearer token", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", SECRET);
    const tampered = signed.replace("abc123", "abc124");
    const request = new NextRequest("http://localhost/api/films", {
      headers: { authorization: `Bearer ${tampered}` },
    });
    const res = await proxy(request);
    expect(res.status).toBe(401);
  });

  it("still 404s the denied organization prefix with a valid bearer", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", SECRET);
    const request = new NextRequest("http://localhost/api/auth/organization/create", {
      method: "POST",
      headers: { authorization: `Bearer ${signed}` },
    });
    const res = await proxy(request);
    expect(res.status).toBe(404);
  });
});
