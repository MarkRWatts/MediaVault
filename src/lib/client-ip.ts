// Best-effort client IP for the app's own throttles (src/lib/throttle.ts)
// and for forwarding on the internal loopback fetches in the auth actions.
//
// Behind Cloudflare Tunnel the trustworthy value is `cf-connecting-ip`,
// which the edge sets and a client cannot override. `x-forwarded-for` is
// the fallback for the LAN/Caddy path; only a single-valued header is
// trusted there (a client can prepend its own entries, and a proxy appends
// the real one, so a multi-valued XFF is ambiguous). Anything else — no
// header at all, an unparsable value — yields null, and callers key their
// throttle on a shared "unknown" bucket rather than skipping it. Mirrors
// the header order given to BetterAuth in src/lib/auth.ts.

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

export function clientIpFromHeaders(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf && IP_RE.test(cf)) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1 && IP_RE.test(parts[0])) return parts[0];
  }
  return null;
}

/** The forwarding headers to copy onto a server-side fetch back into this
 *  app's own /api/auth handler, so BetterAuth's rate limiter sees the real
 *  client rather than 127.0.0.1. */
export function forwardedIpHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const cf = headers.get("cf-connecting-ip");
  if (cf) out["cf-connecting-ip"] = cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) out["x-forwarded-for"] = xff;
  return out;
}
