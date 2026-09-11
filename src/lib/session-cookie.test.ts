// Verifies src/lib/session-cookie.ts against the SAME signing routine
// BetterAuth uses (better-call's signCookieValue), so a change in how the
// cookie is signed upstream fails here rather than silently locking
// everyone out at the proxy.
import { describe, expect, it } from "vitest";
import { serializeSignedCookie } from "better-call";
import { bearerTokenFromHeader, splitSignedCookie, verifySessionCookie } from "./session-cookie";

const SECRET = "test-secret-please-ignore-0123456789";

/** The cookie VALUE exactly as better-call puts it on the wire (its only
 *  public signing entry point returns a whole Set-Cookie string). */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const setCookie = await serializeSignedCookie("better-auth.session_token", value, secret, {});
  return setCookie.slice(setCookie.indexOf("=") + 1).split(";")[0];
}

describe("verifySessionCookie", () => {
  it("accepts a value signed by better-call with the same secret (URL-encoded, as set on the wire)", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", SECRET);
    expect(signed).toContain("%3D"); // the base64 padding is percent-encoded on the wire
    expect(await verifySessionCookie(signed, SECRET)).toBe(true);
  });

  it("accepts the same value already URL-decoded (how a cookie parser may hand it over)", async () => {
    const signed = decodeURIComponent(await signCookieValue("sessiontoken_abc123", SECRET));
    expect(await verifySessionCookie(signed, SECRET)).toBe(true);
  });

  it("rejects a forged presence-only cookie", async () => {
    expect(await verifySessionCookie("x", SECRET)).toBe(false);
    expect(await verifySessionCookie("token.notasignature", SECRET)).toBe(false);
  });

  it("rejects a value signed with a different secret", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", "some-other-secret");
    expect(await verifySessionCookie(signed, SECRET)).toBe(false);
  });

  it("rejects a tampered payload under a real signature", async () => {
    const signed = decodeURIComponent(await signCookieValue("sessiontoken_abc123", SECRET));
    const parts = splitSignedCookie(signed)!;
    expect(await verifySessionCookie(`sessiontoken_abc124.${parts.signature}`, SECRET)).toBe(false);
  });

  it("is a plain no for missing input or missing secret", async () => {
    const signed = await signCookieValue("t", SECRET);
    expect(await verifySessionCookie(null, SECRET)).toBe(false);
    expect(await verifySessionCookie(undefined, SECRET)).toBe(false);
    expect(await verifySessionCookie("", SECRET)).toBe(false);
    expect(await verifySessionCookie(signed, undefined)).toBe(false);
    expect(await verifySessionCookie(signed, "")).toBe(false);
  });
});

describe("bearerTokenFromHeader", () => {
  it("is a plain no for missing or empty input", () => {
    expect(bearerTokenFromHeader(null)).toBeNull();
    expect(bearerTokenFromHeader(undefined)).toBeNull();
    expect(bearerTokenFromHeader("")).toBeNull();
  });

  it("rejects the wrong scheme", () => {
    expect(bearerTokenFromHeader("Basic dGVzdDp0ZXN0")).toBeNull();
    expect(bearerTokenFromHeader("token.notasignature")).toBeNull();
  });

  it("accepts a lowercase scheme and is case-insensitive generally", () => {
    expect(bearerTokenFromHeader("bearer abc123")).toBe("abc123");
    expect(bearerTokenFromHeader("BEARER abc123")).toBe("abc123");
  });

  it("trims surrounding whitespace around the header and the token", () => {
    expect(bearerTokenFromHeader("  Bearer   abc123  ")).toBe("abc123");
  });

  it("is a plain no for a bare scheme with no token", () => {
    expect(bearerTokenFromHeader("Bearer")).toBeNull();
    expect(bearerTokenFromHeader("Bearer ")).toBeNull();
    expect(bearerTokenFromHeader("Bearer   ")).toBeNull();
  });

  it("passes a better-call-signed value through to verifySessionCookie", async () => {
    const signed = await signCookieValue("sessiontoken_abc123", SECRET);
    const header = `Bearer ${signed}`;
    expect(await verifySessionCookie(bearerTokenFromHeader(header), SECRET)).toBe(true);
  });
});
