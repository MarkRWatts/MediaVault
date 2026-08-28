# MediaVault — Households & Accounts Plan

Moving MediaVault from a single-user, no-auth personal app to one shared
library accessible by multiple households (family members), each with their
own login and their own watch history/stats. The library itself stays a
single shared catalogue — this is **not** per-household data partitioning.

Today there is zero auth anywhere: no `User` model, no middleware, no session
handling. That's good news — there's nothing to migrate away from, only
things to add.

## Stack additions

- **BetterAuth**, via its official Prisma adapter (works fine against the
  existing `@prisma/adapter-better-sqlite3` setup). Its CLI
  (`better-auth generate`) adds the required `User`/`Session`/`Account`/
  `Verification` models to `prisma/schema.prisma` directly — no hand-written
  migration for the auth core itself.
- **`organization` plugin** for households: gives us `Organization`/`Member`/
  `Invitation` models out of the box. A household = one Organization; a
  family member = a Member of it. This is the right fit now that there's
  more than one household, rather than a flat owner/viewer role.
- No email-sending infra yet. With a small, known set of family members,
  the pragmatic v1 is: the owner provisions each account directly (or sends
  a BetterAuth invite link by hand), not a public sign-up flow or automated
  email delivery. Add real email invites later if the household count grows.

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

## Auth & gating

- `middleware.ts` (new file) gates every route except `/api/auth/*` — redirect
  to sign-in on no session. One central file, not 38 per-route edits.
- Sign-in page + sign-out control in the nav.
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
| 1 | Install BetterAuth + Prisma adapter, generate schema, migrate | 0.5 day |
| 2 | Auth API route + client hooks (`lib/auth.ts`, `lib/auth-client.ts`) | 0.5 day |
| 3 | `organization` plugin wired up, household = org, manual member provisioning | 0.5–1 day |
| 4 | `middleware.ts` gating + sign-in page + sign-out control | 0.5–1 day |
| 5 | Role gate on the owner-only management routes (list above) | 1 day |
| 6 | End-to-end auth verification (login, redirect, sign-out, role checks) | 0.5 day |
| 7 | `WatchProgress` schema + progress-reporting endpoint + player wiring | 1 day |
| 8 | "Continue watching" UI + resume-from-position playback | 1 day |
| 9 | Stats v1 (watch time, most-watched, recent history) | 1 day |

**Total: ~a week to a week and a half of focused work.** Bounded because
there's no existing auth or tracking to untangle — the auth/household half
(~3–4 days) and the watch-history half (~3.5 days) are genuinely separate
pieces of work and could ship as two separate rounds if useful.

## Explicitly deferred (not in this plan)

- **Jellyfin SSO** (BetterAuth as an OIDC provider via `jellyfin-plugin-sso`,
  so household members skip a separate Jellyfin login) — depends on
  BetterAuth existing first, so it's a natural follow-on once this plan
  ships, not part of it.
- Email-based invitations / public sign-up.
- Per-household content restrictions or library partitioning — the library
  stays one shared catalogue.
- Audio (`AlbumPlayer`) progress tracking, unless requested.
