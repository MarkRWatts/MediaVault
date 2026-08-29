"use server";

// Handles BetterAuth's oauthProvider `consentPage` (see auth.ts). In
// practice this is never shown for Jellyfin — it's registered as a trusted
// client with skip_consent: true (JellyfinClientForm.tsx, /admin) — but
// oauthProvider() requires a working consentPage regardless, for any client
// that isn't skip_consent. See HOUSEHOLDS_PLAN.md "Jellyfin SSO".

import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function decideConsent(formData: FormData): Promise<void> {
  const accept = formData.get("accept") === "true";
  const oauthQuery = String(formData.get("oauthQuery") ?? "");

  // auth.api.oauth2Consent() calls the endpoint directly and its handler
  // needs a genuine ctx.request (it re-resolves the pending authorization
  // through the same machinery /oauth2/authorize uses) — an internal call
  // has none, so this goes over real HTTP instead, forwarding this
  // request's own session cookie (oauth2Consent requires a session).
  //
  // Connects to the app's own internal port, not process.env.BETTER_AUTH_URL
  // — a container calling back into its own public HTTPS domain can't
  // reach itself (hairpin NAT through the VM's edge proxy). The Origin
  // header below still claims the real public URL: BetterAuth's CSRF
  // check reads that header value, and doesn't care what the TCP
  // connection's actual destination was.
  const reqHeaders = await headers();
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  const res = await fetch(`http://localhost:3000/api/auth/oauth2/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: reqHeaders.get("cookie") ?? "",
      // Session-protected, state-changing endpoint — BetterAuth's
      // origin/CSRF check rejects a server-side fetch with no Origin.
      origin: base,
    },
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
  const result = await res.json().catch(() => null);

  if (result && typeof result === "object" && "url" in result && typeof result.url === "string") {
    redirect(result.url);
  }
  redirect("/");
}
