// Signature check for BetterAuth's session cookie, for src/proxy.ts.
//
// BetterAuth sets the session cookie as a *signed* value — via better-call's
// setSignedCookie: `${token}.${base64(HMAC-SHA256(secret, token))}`, then
// URL-encoded (node_modules/better-call/dist/crypto.mjs). Its own
// getSessionCookie() helper, which the proxy used to call on its own, only
// reports whether a cookie by that name is *present* — it never checks the
// signature — so any request carrying `better-auth.session_token=x` passed
// the proxy. That was fine while every page and route did its own real
// getSession() check; it is not a gate anyone should rely on, and this app
// had grown routes that did rely on it.
//
// This verifies the HMAC with WebCrypto only (no database, no Prisma), so
// it stays cheap enough to run on every request. It answers "was this
// cookie minted by this server?", not "is the session still live?" — a
// revoked or expired session still carries a valid signature. The
// authoritative check stays in the page/route handlers
// (src/lib/require-member.ts); this layer just makes forging a cookie
// useless as a way past the proxy.

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function keyFor(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: crypto.subtle.importKey("raw", new TextEncoder().encode(secret), ALGORITHM, false, ["verify"]),
    };
  }
  return cachedKey.key;
}

/** Split a signed cookie value into its payload and base64 signature, or
 *  null if it isn't shaped like one. Accepts the value either still
 *  URL-encoded (as it sits on the wire) or already decoded. */
export function splitSignedCookie(raw: string): { value: string; signature: string } | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not URL-encoded (or malformed) — try it as-is.
  }
  const at = decoded.lastIndexOf(".");
  if (at < 1) return null;
  const value = decoded.slice(0, at);
  const signature = decoded.slice(at + 1);
  // HMAC-SHA256 is 32 bytes -> exactly 44 base64 chars ending in "=".
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  return { value, signature };
}

/** Pull the token out of an `Authorization: Bearer <token>` header, or null
 *  if there isn't one — used by src/proxy.ts to accept a native client's
 *  bearer session alongside the cookie (IOS_PLAN.md). Case-insensitive on
 *  the scheme (per RFC 9110) and trims incidental whitespace; does no
 *  signature verification itself — the caller runs the result through
 *  verifySessionCookie exactly as it does the cookie value. */
export function bearerTokenFromHeader(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const trimmed = authorization.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** True iff `raw` is a session cookie value signed with `secret`. Any
 *  missing/malformed input, or a missing secret, is simply "no". */
export async function verifySessionCookie(raw: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (!raw || !secret) return false;
  const parts = splitSignedCookie(raw);
  if (!parts) return false;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    const bin = atob(parts.signature);
    sigBytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(ALGORITHM, await keyFor(secret), sigBytes, new TextEncoder().encode(parts.value));
  } catch {
    return false;
  }
}
