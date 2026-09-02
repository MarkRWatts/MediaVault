# MediaVault — Passkeys Plan

Add passkeys (WebAuthn / FIDO2 discoverable credentials) as a second way to
sign in, alongside — never instead of — the existing email one-time-code
flow. Face ID / Touch ID / Windows Hello / a synced iCloud-Keychain or
Google-Password-Manager passkey gets a household member into the app in one
tap, with no email round-trip. Email OTP stays exactly as it is today: it is
the universal fallback, the recovery path, and the only way a brand-new
account ever gets created. The web of trust (`HOUSEHOLDS_PLAN.md` "Access
codes & the web of trust") is untouched — see "Auth & gating" below for why
it applies to passkey sign-ins automatically.

Verified against the installed BetterAuth (`better-auth@1.7.2`) and its
matching plugin package (`@better-auth/passkey@1.7.2`, inspected from the
published tarball — see "Stack additions"). Every claim below about what the
plugin does was read from its shipped source, not from memory.

## Stack additions

- **`@better-auth/passkey@1.7.2`** — BetterAuth's own passkey plugin, split
  out of the core package in the 1.3 line (it is *not* under
  `better-auth/plugins` in 1.7.2 — confirmed by listing that directory).
  Pin to exactly the installed `better-auth` version, as the other
  `@better-auth/*` packages already are. Pure JS: no native build, so
  nothing changes in the Dockerfile's builder stage or CI beyond the
  existing `npm ci --legacy-peer-deps`.
  - Pulls in `@simplewebauthn/server@^13.3` (verification) and
    `@simplewebauthn/browser@^13.3` (the `navigator.credentials` ceremony
    wrapper). Its exact-pinned peers (`better-call@1.4.0`,
    `@better-auth/utils@0.4.2`, `@better-fetch/fetch@1.3.1`,
    `@better-auth/core@^1.7.2`, `zod@^4.3.6`) all match what is already in
    `node_modules` today — verified with `npm ls` — so there is no risk of a
    second `better-call` copy breaking `instanceof APIError` checks.
- **No new env vars.** The Relying Party ID is derived from
  `BETTER_AUTH_URL`'s hostname by the plugin (`mediavault.markrwatts.com` in
  prod, `localhost` in dev), and the expected origin is set explicitly to
  `BETTER_AUTH_URL` rather than trusting the request's `Origin` header (the
  plugin's default when `origin` is unset).

**Secure-context requirement (worth knowing before anyone tests on a
phone):** WebAuthn only runs on HTTPS or `localhost`. Production behind the
shared Caddy is fine; `next dev` on `http://localhost:3002` is fine; opening
the dev server from a phone via the Mac's LAN IP (`http://192.168.x.x:3002`)
is **not** — the passkey button will be hidden there by the feature-detect
in Phase 3, not broken. Also note passkeys are bound to the RP ID, so a
passkey registered against `localhost` will never work on prod and vice
versa — expected, not a bug.

## Data model changes

One new table, shaped exactly as the plugin's schema declares it (read from
`@better-auth/passkey/dist/index.d.mts`), mapped to the lowercase table name
the way `Jwks`/`OauthClient` already are:

```prisma
// Passkeys — see PASSKEYS_PLAN.md. One row per registered authenticator
// (a phone, a laptop, a security key). Column set is what
// @better-auth/passkey expects; nothing app-specific added.
model Passkey {
  id           String   @id
  name         String?
  publicKey    String
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  credentialID String
  counter      Int
  deviceType   String
  backedUp     Boolean
  transports   String?
  createdAt    DateTime @default(now())
  aaguid       String?

  @@index([userId])
  @@index([credentialID])
  @@map("passkey")
}
```

plus `passkeys Passkey[]` on `User`.

- `onDelete: Cascade` is load-bearing: `deleteAccount`
  (`src/app/actions/account.ts`) deliberately bypasses BetterAuth's
  `/delete-user` and does a plain `prisma.user.delete`, relying on the
  schema's cascades to take Session/Account/Member with it. Passkeys must
  ride the same cascade or a deleted user leaves orphan credentials that
  can never sign in (the session hook would refuse) but never get cleaned
  up either.
- `credentialID` gets an index (the plugin looks passkeys up by it on
  every sign-in); a `@unique` would be stricter, but the plugin's own
  schema declares `index`, and `excludeCredentials` at registration already
  prevents re-registering the same authenticator for the same user.
- The registration/authentication **challenge** is *not* a new table: the
  plugin stores it in the existing `verification` table under a random
  identifier that rides in a short-lived signed cookie
  (`better-auth-passkey`), same mechanism email OTP already uses. Nothing
  to add.
- Migration: `npx prisma migrate dev --name add_passkeys`, applied in prod
  by the existing boot-time `prisma migrate deploy`. Forward-only and
  additive — safe to roll back the code without rolling back the table.

## Design: what a passkey can and cannot do here

- **Sign in** — an existing account only. The plugin's authentication
  endpoint looks up the presented credential, verifies the assertion, then
  creates a session for that credential's `userId`. There is no
  passkey-first sign-up: creating an account still means the OTP flow (and,
  for a new household, an access code on `/signup`). This is a deliberate
  scope choice, not a limitation to work around — the web of trust's
  "vouched-for email" model has nothing to attach a bare credential to.
- **Register** — only from a signed-in session, and only a *fresh* one. The
  plugin wraps both registration endpoints in BetterAuth's
  `freshSessionMiddleware`, i.e. the session must be younger than
  `session.freshAge` (default **24 h**, confirmed in
  `@better-auth/core`'s option types). That is a built-in sudo mode: a
  stolen-but-old session cookie cannot be used to quietly enrol a
  persistent credential. The UX cost is real and must be designed for, not
  discovered: a member who signed in a week ago and opens `/account` will
  get a "session not fresh" error from "Add a passkey". See Phase 2.
- **Discoverable credentials** (`residentKey: "required"`). Sign-in is
  username-less: the user never types an email, the authenticator presents
  which passkeys it holds for this RP. This is what makes the one-tap flow
  and the browser autofill ("conditional UI") work. The trade-off — some
  hardware security keys have limited resident-key slots — is acceptable
  for this app's audience (phones and laptops with platform
  authenticators). `userVerification` stays `"preferred"` (the plugin's
  default): required-UV would refuse a key without a PIN/biometric, and the
  session gate, not UV, is the real access control here.
- **Attestation: none** (plugin default, not configurable). Consequence
  for labelling: Apple zeroes the AAGUID under `attestation: "none"`, so the
  plugin's `getAuthenticatorName(aaguid)` helper will identify a Google /
  Windows / 1Password passkey but return `undefined` for every iPhone and
  Mac — the majority case. The management UI therefore always asks for /
  suggests a name rather than relying on AAGUID (see Phase 2).

## Auth & gating

- **The web of trust applies to passkey sign-ins with zero new code.** The
  plugin's `verify-authentication` creates its session through
  `ctx.context.internalAdapter.createSession(passkey.userId)` — the same
  path every sign-in method takes — so `src/lib/auth.ts`'s
  `databaseHooks.session.create.before` runs and `isAllowedEmail()` is
  consulted. A member removed from their household (or an invitee whose
  invitation was cancelled) keeps their passkey row but can no longer turn
  it into a session: the hook returns `false`, the plugin throws
  `UNABLE_TO_CREATE_SESSION`, and the client gets a 500. Existing live
  sessions are unaffected, exactly as with OTP today. **Phase 1 must
  include a test that pins this** (it is the one property everything else
  rests on).
- **`proxy.ts` needs no change.** All plugin endpoints live under
  `/api/auth/passkey/*`, already in the public prefix list. Route handlers
  don't need touching either — `toNextJsHandler(auth)` picks up the new
  endpoints automatically.
- **Ownership on manage endpoints is server-enforced by the plugin.**
  `delete-passkey` and `update-passkey` are wrapped in `sessionMiddleware`
  + `requireResourceOwnership({ model: "passkey" })`, so a member can only
  rename/remove their own rows even if they forge the `id` in the request.
  `list-user-passkeys` is session-scoped. The app's own server actions add
  audit logging on top, not authorization.
- **Error handling must not turn into an oracle.** The sign-in button maps
  plugin error codes to three user-facing states and nothing more:
  cancelled/aborted (say nothing), `PASSKEY_NOT_FOUND` /
  `AUTHENTICATION_FAILED` ("That passkey isn't set up for MediaVault — use
  the email code"), and anything else including the web-of-trust refusal
  ("Couldn't sign you in — use the email code"). Same posture as
  `verifyOTP`'s one-message-for-every-failure.
- **Audit** (`src/lib/audit.ts`, content-free by design): `passkey.add`
  via the plugin's `registration.afterVerification` hook (server-side, so it
  fires whether the UI or a curl did it), `passkey.rename` and
  `passkey.remove` from the server actions. No `passkey.signin` — the app
  doesn't audit OTP sign-ins either, and the session row is the record.
- **Jellyfin SSO** (`oauthQuery`) is the one flow that needs care. OTP
  sign-in on the SSO path has to go over real HTTP so `@better-auth/oauth-
  provider`'s hooks fire (see `verifyOTP`). Passkey sign-in always goes over
  real HTTP from the browser, which is the good news; the open question is
  whether the provider's `before` hook — which matches on
  `ctx.body.oauth_query` — sees that field on `/passkey/verify-
  authentication`, whose own body schema doesn't declare it. This is
  answerable only by trying it (Phase 5). Until then the passkey button is
  simply **not rendered when `oauthQuery` is set**: a Jellyfin sign-in
  keeps using OTP, which works today. No half-working state ships.

## Before writing any code

`AGENTS.md` requires reading the relevant Next.js guide under
`node_modules/next/dist/docs/` first — this Next.js differs from training
data. The ones that matter for this plan: `01-app/02-guides/server-actions.md`
(the rename/remove actions), `01-app/02-guides/authentication.md`, and the
`03-api-reference/01-directives` folder (`use client` boundaries — the
WebAuthn ceremony is browser-only and must live in a client component).

## Rollout phases (rough effort)

| Phase | Work | Est. |
|---|---|---|
| 1 | **Plumbing** — **done**. `@better-auth/passkey@1.7.2` (lockfile purely additive: the plugin plus `@simplewebauthn/*` and its ASN.1 deps; `npm ls` confirmed one `better-call`). `src/lib/auth.ts` gained `passkey({ rpName: "MediaVault", origin: BETTER_AUTH_URL, residentKey: "required", afterVerification → logAudit("passkey.add") })` ahead of `nextCookies()`; `src/lib/auth-client.ts` gained `passkeyClient()`. `Passkey` model + `20260902141757_add_passkeys` migration (cascade on user confirmed in the generated SQL). `src/lib/passkey.test.ts` pins, against a real temp SQLite: cascade on `user.delete`; a passkey holder nobody vouches for gets `null` from `internalAdapter.createSession` (the exact call the plugin's verify-authentication makes) while a member or an `ALLOWED_EMAILS` address gets a session; anonymous `generatePasskeyRegistrationOptions` is 401. Note for the test: `auth.ts` hands `prisma` to the adapter at import time, so the temp DB must exist before the module is imported | 0.5 day |
| 2 | **`/account` → "Passkeys" section** — **done**, as designed: server-side `prisma.passkey.findMany` → `PasskeyManager` client component; rename/remove are `app/actions/passkeys.ts` server actions (`auth.api.updatePasskey` / `deletePasskey`, which enforce ownership themselves) + `passkey.rename` / `passkey.remove` audit rows; add is client-side `authClient.passkey.addPasskey({ name })` with the name suggested by `src/lib/passkey-label.ts` (unit-tested) and the AAGUID label resolved server-side. Fresh-session 403 renders its own explanation with `SignOutButton` inline. One deviation from the plan text: client-only facts (WebAuthn support, user-agent) come through `useSyncExternalStore` with a server snapshot (`src/lib/use-passkey-support.ts`), not `setState` in an effect — the repo's `react-hooks/set-state-in-effect` lint rule rejects the latter, and the store approach also means the add button appears on the first client render instead of a frame late | 1 day |
| 3 | **`/signin` → passkey sign-in** — **done**, as designed: `PasskeySignInButton` under the email form, only when `oauthQuery === undefined` and only in a secure context with WebAuthn (same `useSyncExternalStore` hook); conditional-UI autofill kicked off on mount with `autoComplete="username webauthn"` on the email field; the button goes pending for good once any ceremony succeeds, so autofill and a click can't mint two sessions. **Verified end to end** against `next dev` with Chromium's CDP virtual authenticator (`ctap2`, resident key, UV, auto-presence) and a session seeded straight into the DB (better-auth's cookie is just `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))`): register → rename → sign out → passkey sign-in (landed via autofill — Chrome auto-resolves conditional mediation against a virtual authenticator) → member row deleted → passkey sign-in refused with the generic message and no session row → member restored → remove → sign-in gets the not-set-up message → a two-day-old session still browses but gets the sign-out-and-back-in explanation when adding. 25/25 checks; server log showed only the expected 500 (`UNABLE_TO_CREATE_SESSION`) and 401s. The harness lives outside the repo for now — see Phase 6 | 0.5–1 day |
| 4 | **Post-OTP nudge** (optional, small): after a successful `verifyOTP` on a device that supports passkeys, a one-time dismissible strip on the landing page — "Sign in faster next time: add a passkey for this device" → `/account#passkeys`. This is exactly when the session is freshest, so it sidesteps the Phase 2 fresh-session friction for the common case. Dismissal remembered in `localStorage` (per-device convenience, not server state). | 0.5 day |
| 5 | **Jellyfin SSO via passkey** (optional): against a real dev server, start an SSO sign-in from Jellyfin, complete it with a passkey, and confirm the provider's `after` hook (which matches on the session cookie being set) redirects back to Jellyfin. If the `before` hook doesn't see `oauth_query` on the passkey endpoint, the fallback is threading it the way `verifyOTP` does — or leaving the SSO path OTP-only and saying so in `HOUSEHOLDS_PLAN.md`'s Jellyfin SSO section. Either outcome is fine; shipping the button on that path *untested* is not. | 0.5 day |
| 6 | **Verification + docs + deploy.** End-to-end against `next dev` with Playwright + Chromium's CDP virtual authenticator (`Browser.addVirtualAuthenticator`, `ctap2`, `hasResidentKey: true`, `hasUserVerification: true`, `isUserVerified: true`): register from `/account`, sign out, sign back in via the button, then via autofill, then remove the passkey and confirm sign-in with it now fails cleanly. Keep this as a `scripts/e2e-passkey.ts` the owner can run, not a vitest test — it needs a browser and a running server, which CI doesn't have. Manual pass on a real iPhone + Safari on the Mac (iCloud Keychain sync between them is the headline feature). README "Authentication (required)": one sentence that passkeys are an optional per-device addition; env-var table unchanged. Deploy per `DEPLOYMENT.md` "Updating the deployment". | 0.5 day |

**Total: ~3–4 days of focused work.** Phases 1–3 are the feature; 4–6 are
polish and proof. Phase 1 alone is safe to merge with nothing user-visible
(the plugin endpoints exist but no UI calls them).

## Things that could go wrong (and where they're caught)

- **Fresh-session rejections on `/account` look like a bug.** Handled in
  Phase 2's UX, and mostly avoided by Phase 4's timing.
- **A member sees "Add a passkey" on a LAN-IP dev URL and it silently does
  nothing.** The Phase 3 feature-detect hides it; Phase 2's button should
  do the same check so it says "Passkeys need a secure (https) connection"
  rather than failing.
- **Session refused after a successful biometric prompt** (removed member):
  the biometric succeeds on-device, the server then 500s. The Phase 3
  error mapping shows the generic message; the Phase 1 test pins the
  refusal itself.
- **Two `better-call` copies.** Ruled out above by version alignment, but
  `npm ls better-call` after install is a 2-second check worth doing.
- **Prisma model name.** BetterAuth addresses the model as `passkey`; with
  `@@map("passkey")` on `model Passkey`, the Prisma adapter resolves
  `prisma.passkey` — the same convention already working for
  `Jwks`/`OauthClient`. If the plugin's field names ever need remapping the
  plugin exposes `schema: { passkey: { fields: {...} } }`, same as the
  organization plugin's `modelName`/`fields` overrides in `auth.ts`.

## Explicitly deferred (not in this plan)

- **Passkey-only accounts / removing email OTP.** OTP is the recovery path;
  keeping it means no recovery codes, no "lost my phone" support flow.
- **Passkey-first sign-up** (`registration.requireSession: false` +
  `resolveUser`). Nothing in the web of trust to attach it to; `/signup`
  stays access-code + OTP.
- **MediaVaultTV (tvOS) sign-in with passkeys.** The native app talks to
  `/api/films` today with no auth flow of its own; passkeys on tvOS are a
  separate native-side project.
- **Attestation / authenticator allow-lists, admin visibility of members'
  passkeys, per-passkey last-used tracking.** None needed for a household
  app; the audit log already records adds/removes.
