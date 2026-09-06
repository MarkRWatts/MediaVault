// Did this request arrive through the Cloudflare Tunnel (i.e. from the
// internet) or over the LAN (Caddy, or `next dev`)? Cloudflare stamps
// `cf-connecting-ip` and `cf-ray` on everything it proxies; nothing on the
// LAN path does. Spoofable by a LAN client, which only costs them a lower
// default video quality — this is a UX hint, never an authorization input
// (the rate limiter's use of cf-connecting-ip is separate and documented in
// src/lib/auth.ts).
//
// Consumers: app/layout.tsx stamps <html data-network="…"> so client
// components (VideoPlayer) can pick a sensible default without a round
// trip; server components use it to hide LAN-only links ("Play in
// Jellyfin" points at JELLYFIN_URL, unreachable from outside).

export type NetworkKind = "lan" | "remote";

export function networkKind(headers: Headers): NetworkKind {
  return headers.has("cf-connecting-ip") || headers.has("cf-ray") ? "remote" : "lan";
}
