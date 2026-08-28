# MediaVault — Households & Accounts Plan

Moving MediaVault from a single-user, no-auth personal app to one shared
library accessible by multiple households (family members), each with their
own login and their own watch history/stats. The library itself stays a
single shared catalogue — this is **not** per-household data partitioning.

Today there is zero auth anywhere: no `User` model, no gating, no session
handling. That's good news — there's nothing to migrate away from, only
things to add.

## Stack additions

- **BetterAuth**, via its official Prisma adapter (works fine against the
  existing `@prisma/adapter-better-sqlite3` setup). Its CLI
  (`better-auth generate`) adds the required `User`/`Session`/`Account`/
  `Verification` models to `prisma/schema.prisma` directly — no hand-written
  migration for the auth core itself.
- **`organization` plugin** for households: gives us `Organization`/`Member`/
  `Invitation` models out of the box, renamed via the plugin's own
  `schema.modelName`/`fields` remapping to `Household`/`Member`/`Invitation`
  so the domain language matches the app instead of staying generic (this
  is exactly what jinglejotter.com does — see `auth.ts` there). One
  household per user, enforced via the plugin's `organizationLimit` hook
  (checks for an existing `Member` row) rather than the plugin's native
  multi-org default; `disableOrganizationDeletion: true` since a
  household's library access is the point, never silently removable.
- **Auth method: email OTP only** (see "Access codes & the web of trust"
  below) — no password, no OAuth. This means **email-sending is a required
  prerequisite, not deferred work**, since the OTP *is* the credential.
  Resolved: **Resend**, already domain-verified for `markrwatts.com` (the
  same provider jinglejotter.com uses) — no SDK, just a plain `fetch` to
  `https://api.resend.com/emails` with `RESEND_API_KEY` (see
  `jinglejotter.com/app/lib/email.ts`'s `sendEmail()`, ported as-is). From
  address: `MediaVault <noreply@markrwatts.com>` (adjust the local part if
  you'd rather something else — any address on the verified domain works).

## Data model changes

Nothing changes on `Film`/`Show`/`Album`/`Version`/etc. — the library stays
fully shared. Two additions:

1. BetterAuth + organization plugin's own models (generated, not hand-designed).
2. A new `WatchProgress` model for per-user resume position and stats. Films
   and TV episodes don't share an id space today (`Version` vs `EpisodeFile`
   are separate tables), so this needs exactly one of two FKs set per row:

   ```prisma
   model WatchProgress {
     id            Int       @id @default(autoincrement())
     userId        String    // BetterAuth User.id
     versionId     Int?
     version       Version?     @relation(fields: [versionId], references: [id], onDelete: Cascade)
     episodeFileId Int?
     episodeFile   EpisodeFile? @relation(fields: [episodeFileId], references: [id], onDelete: Cascade)
     positionSecs  Float
     completed     Boolean   @default(false)
     playCount     Int       @default(0)
     updatedAt     DateTime  @updatedAt

     @@unique([userId, versionId])
     @@unique([userId, episodeFileId])
     @@index([userId])
   }
   ```

   (Enforcing "exactly one FK set" is an app-level invariant, same as SQLite's
   general lack of CHECK-constraint support elsewhere in this schema.)

## Access codes & the web of trust

Ported from jinglejotter.com's real, shipped implementation
(`/Users/mark/claude-code/jinglejotter.com/app`: `auth.ts`, `lib/access.ts`,
`lib/allowed-email.ts`, `lib/otp-email.ts`, `app/actions/auth-flow.ts`,
`app/actions/household.ts`) — not a fresh design, a port. Read those files
before touching this phase; the summary below is deliberately compressed.

**The gate.** Nobody signs in on identity alone — an email must be *vouched
for* by one of:

1. A root anchor env list (`ALLOWED_EMAILS` — Mark's own address(es)). The
   one thing no database state can lock out.
2. Membership: an existing `Member` row for that email — **not** any `User`
   row. BetterAuth creates the `User` row before a session-create hook can
   refuse it, so an orphaned `User` from a refused sign-in must never vouch
   for itself.
3. A pending, unexpired household `Invitation` for that email.
4. A live, unredeemed `AccessCode` minted for that email.

Checked in two places: before sending an OTP at all (silently no-ops for a
stranger — the send path never confirms or denies an email is known, so
nobody can probe which addresses this app recognizes), and authoritatively
in a `databaseHooks.session.create.before` hook that re-checks on *every*
sign-in, not just account creation.

**Credential: email OTP only.** No password, no OAuth — a 6-digit code,
10-minute expiry, 3 attempts, via BetterAuth's `emailOTP` plugin. (JingleJotter
arrived here after retiring Google OAuth and magic links, partly because a
magic link tapped in Mail opens the wrong cookie jar for an installed
PWA/home-screen app — worth keeping in mind if MediaVault ever goes that
route too, but not a reason to revisit for a plain browser tab today.)

**Two ways in:**

- **Brand-new household** — needs an `AccessCode` (the trust boundary for
  admitting a household MediaVault doesn't already know). `/signup`
  collects name + email + code; the code must be email-bound *and* match
  the typed email (a forwarded code is useless to anyone else). OTP is sent
  and verified, then `createHousehold` claims the code atomically and
  creates the org.
- **Invited into an existing household** — no code needed; a pending
  `Invitation` itself is the vouch, so the invitee just uses plain
  `/signin`. Invite acceptance is by bearer token (the invitation row's own
  id, not matched to the invitee's email — deliberately bypasses
  BetterAuth's own email-matched `acceptInvitation`, modelled on how
  Tailscale invite links work: whoever holds the link can redeem it).

**`AccessCode` model** (simplified from jinglejotter.com's version — that
one carries a `kind`/`accessExpiresAt` pair for its trial-vs-lifetime
monetization split, which doesn't apply here and is deliberately dropped):

```prisma
model AccessCode {
  id              String    @id @default(cuid())
  code            String    @unique // canonical form: MV + 8 chars, no 0/O/1/I/L
  email           String?   // null = claimable by anyone signed in; set = bound to one address
  maxRedemptions  Int       @default(1)
  redeemedCount   Int       @default(0)
  redeemableUntil DateTime?
  createdAt       DateTime  @default(now())
}
```

Minted by a small admin script (mirrors `scripts/gen-access-code.ts`), not a
UI — same reasoning as the plugin config itself: this is owner-run
tooling, not a self-serve growth surface. Claimed via a conditional
`updateMany` (`redeemedCount: { lt: <maxRedemptions> }`, not-yet-expired) so
two racing claims on the last slot of a shared code can't both win — only
the update whose `WHERE` still matches succeeds. One user-facing error
message covers every failure mode (unknown code, expired, exhausted, wrong
email) — distinguishing them would tell a guesser which codes/emails exist.

**Two things to verify, not assume, when this phase is actually built** —
jinglejotter.com runs Postgres; MediaVault runs SQLite via
`better-sqlite3`, and two of the mechanisms above lean on
provider-specific behaviour:

- The conditional-`updateMany` claim compares one column to another
  (`redeemedCount` against `maxRedemptions`) inside a `where` — Prisma's
  field-to-field filter comparison. Confirm this generates correct SQL
  against the SQLite provider before relying on it for concurrency safety.
- Invite-token acceptance in jinglejotter.com wraps its race check in a
  `{ isolationLevel: "Serializable" }` transaction. Prisma's SQLite
  connector may not support explicit isolation levels the same way Postgres
  does (SQLite's own locking model is single-writer regardless) — needs a
  real check, and if it doesn't apply cleanly, the one-household-per-user
  race guard needs an equivalent SQLite-native path (e.g. a unique
  constraint doing the work instead of transaction isolation).

## Auth & gating

- `proxy.ts` (new file — **not** `middleware.ts`: this Next.js version
  deprecated and renamed that convention, confirmed in
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`;
  jinglejotter.com's own equivalent file is correctly named `proxy.ts` too)
  gates every route except `/api/auth/*`, `/signin`, `/signup`, and the
  `/invite/` prefix — redirect to sign-in on no session. One central file,
  not 38 per-route edits. Optimistic cookie-presence check only (no DB hit,
  since this runs on every request) — real authorization still happens via
  `auth.api.getSession()` in the actual page/route.
- Sign-in page (email → OTP, two steps, no code needed) + a separate
  sign-up page (name + email + access code, for a brand-new household) +
  sign-out control in the nav — see "Access codes & the web of trust" above
  for the actual flow.
- Role check (Organization member role: owner vs member) on anything that
  updates the library or reports on its state — owner (product owner) only:
  `scan`, `enrich`, `enrich-music`, `backfill-cds`, `physical-add`,
  `film-physical`, `digital-source`, `barcode`, `album-match`,
  `jellyfin-sync`, `runs`, and the `/report` page (missing films, upgrade
  candidates, unmatched/low-confidence entries — collection bookkeeping for
  the owner, not something other members need).
- Everything else — browsing and playback (`film`, `shows`, `music`,
  `collections`, `video/*`, `poster`, `cover`, `audio`) — is fair game for
  any signed-in household member, regardless of role. Verified via direct
  route inspection that `films`/`poster`/`cover` are GET-only today (no
  hidden mutation to gate) and the video `prepare` POST is a playback-support
  action (kicks off transcode/cache), not a library edit — it stays open.

## Watch history & stats

New subsystem — nothing like it exists today (confirmed: no progress/watched
field anywhere in the current schema or code).

1. **Progress reporting** — `VideoPlayer.tsx` gets a throttled `timeupdate`
   handler (not per-frame) plus a flush on pause/unload, POSTing to a new
   `/api/video/[versionId]/progress`-style route. Same shape needed for
   `AlbumPlayer.tsx` if audio gets progress tracking too (defer unless asked).
2. **Continue watching** — a row on the browse pages pulling the signed-in
   user's own in-progress titles; resume playback from the stored position
   instead of byte 0.
3. **Stats v1** — deliberately kept small and real rather than a full
   analytics dashboard: total watch time, most-watched titles/genres,
   per-user recently-watched list. A richer stats page is easy to add later
   once the underlying `WatchProgress` events exist — build the event
   plumbing now, the dashboard later.

## Rollout phases (rough effort)

| Phase | Work | Est. |
|---|---|---|
| 1 | Install BetterAuth + Prisma adapter, generate schema, migrate — **done**, `worktree-agent-acdb77a6360ccdd03` | 0.5 day |
| 1.5 | Wire Resend (`RESEND_API_KEY`, `sendEmail()` ported from jinglejotter.com) — **done**, merged | 0.25 day |
| 2 | Auth API route + client hooks (`src/app/api/auth/[...all]/route.ts`, `src/lib/auth-client.ts`) — **done**, merged | 0.5 day |
| 3 | `organization` plugin (→ Household/Member/Invitation), `emailOTP` plugin, the
web-of-trust `databaseHooks` gate, `AccessCode` model + admin mint script — **done**, merged, real SQLite concurrency tests added | 1.5–2 days |
| 4 | `proxy.ts` gating + `/signin` (OTP) + `/signup` (code) + `/onboarding` +
`/invite/[token]` pages + sign-out + minimal invite-a-member action — **done**, verified end-to-end (both join paths, sign-out, invite/cancel/accept) against a real SQLite db | 1.5–2 days |
| 5 | Role gate on the owner-only management routes (list above) | 1 day |
| 6 | End-to-end auth verification (both join paths, redirect, sign-out, role checks,
the two SQLite compatibility items above) | 1 day |
| 7 | `WatchProgress` schema + progress-reporting endpoint + player wiring | 1 day |
| 8 | "Continue watching" UI + resume-from-position playback | 1 day |
| 9 | Stats v1 (watch time, most-watched, recent history) | 1 day |

**Total: ~1.5–2 weeks of focused work** — up from the earlier estimate now
that the real access-code/OTP/web-of-trust design is ported in rather than
a flat role + manual provisioning. Auth/households (~5–6.5 days) and
watch-history (~3 days) are still genuinely separate and shippable as two
rounds.

## Explicitly deferred (not in this plan)

- **Jellyfin SSO** (BetterAuth as an OIDC provider via `jellyfin-plugin-sso`,
  so household members skip a separate Jellyfin login) — depends on
  BetterAuth existing first, so it's a natural follow-on once this plan
  ships, not part of it.
- Public, code-free self-serve sign-up — every new household still needs an
  owner-minted access code, same posture as jinglejotter.com. Only the
  *invite-into-an-existing-household* path skips the code.
- Per-household content restrictions or library partitioning — the library
  stays one shared catalogue.
- Audio (`AlbumPlayer`) progress tracking, unless requested.
