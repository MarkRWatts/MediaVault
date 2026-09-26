# MediaVault — removing Jellyfin, and Adult as a module

Two pieces of work, planned together because they touch the same files:

1. **Jellyfin goes entirely.** That means playback through it, library
   sync, the Adult library-policy sync, the "Play in Jellyfin" link, and
   the OIDC provider that existed only so people could sign in to Jellyfin.
   It is not kept as an extension, because it isn't expected to be needed
   again.
2. **The Adult media type becomes a module that a build can leave out.**
   A **clean** build contains no Adult code, routes, UI or data model, for
   App Store review and anywhere else it is wanted. A **full** build keeps
   everything the household uses today: scanning, ThePornDB enrichment,
   in-app playback, and per-member gating.

This supersedes [V4_PLAN.md](V4_PLAN.md) "Removing Jellyfin" and phase 6.

## Status (26 Sep 2026)

Planning only. Nothing below is implemented yet.

Decided 26 Sep 2026:

1. **The household's Jellyfin server is being retired**, not just
   MediaVault's use of it.
2. **The "Play in Jellyfin" button on Adult scenes goes.** Scenes play in
   the app through the engine.
3. **Modules can be switched on and off from `/admin`** without a redeploy,
   as well as being left out of a build altogether.
4. **No Jellyfin support is kept for the future.** Everything is removed,
   including the OIDC provider. The last state of the code stays reachable
   at the `jellyfin-final` tag.
5. **The Adult module exists to make a clean build possible**, for App
   Store submission, while the full build keeps Adult content enriched and
   gated.

## Where things stand

- **Production no longer plays through Jellyfin.** The VM has run
  `PLAYBACK_ENGINE=local` with `PLAYBACK_HWACCEL=vaapi` since 20 Sep
  ([UHD_PLAN.md](UHD_PLAN.md) "Measured"). The code, though, still defaults
  to `jellyfin` (`src/lib/playback/engine-flag.ts:29`,
  `docker-compose.yml:69`).
- **What Jellyfin still does:**
  - **Library sync** (`src/lib/jellyfin.ts`, about 740 lines). After film
    and TV scans, and in the nightly tick, it writes `jellyfinId` onto
    `Version`, `EpisodeFile` and `Scene`. Under the local engine, the only
    thing that reads those ids is the "Play in Jellyfin" link on the scene
    page.
  - **Adult-library policy sync** from the `/account` opt-in
    (`src/app/actions/adult.ts`, `AdultAccessToggle.tsx`).
  - **Jellyfin SSO.** BetterAuth's `jwt()` and `oauthProvider()` plugins
    (`src/lib/auth.ts:184-206`), plus `/consent`, the `oauthQuery` path
    through `/signin`, `OTPForm` and `auth-flow.ts`, and the admin
    client-registration form. Jellyfin is its only client.
  - **Not Jellyfin, though named after it.** Apple TV device sign-in
    (`deviceAuthorization`, `/device`) and native bearer tokens (`bearer()`)
    are separate plugins. They don't depend on `jwt()` or
    `oauthProvider()`.
- **Jellyfin in name only:**
  - **The `jellyfin-ffmpeg` build** in the `Dockerfile`, `ffmpeg-bin.ts`
    and `head-args.ts`. This is our transcoder binary, not the server
    ([V4_PLAN.md](V4_PLAN.md) "ffmpeg: jellyfin-ffmpeg, pinned"). **It
    stays.**
  - **The `/jf/session`, `/jf/stop` and `/jf/e/<key>/…` URLs**, the
    `"jellyfin"` `PlaybackSource` value and `features.jellyfin` in
    `/api/v1/me`. These are the iOS app's contract and already serve from
    the engine. Renaming them needs an app release (phase J4).
- **The Adult media type is spread across about 60 files**. It has:
  - its own models;
  - `User.adultLibraryAccess`;
  - a `SCENE` entry in the scanner and run tables;
  - `scene` in both playback `MediaKind` unions;
  - hard-coded nav, account and admin rows;
  - playback routes still on the parked `video-cache.ts` pipeline.

  `/api/v1` already carries no Adult data, and the iOS app never calls
  Adult routes ([IOS_PLAN.md](IOS_PLAN.md) "Out of scope", App Store
  Guideline 1.1.4). Its design notes are in the untracked `ADULT_PLAN.md`,
  which this document does not repeat.

---

## Part 1 — Removing Jellyfin

### Decisions

**Delete, don't park.** There is no Jellyfin extension, no `OIDC_PROVIDER`
switch, and no link tables. Removed code costs nothing to keep; parked code
is still code to compile, test and reason about. Tag the last commit before
removal starts as **`jellyfin-final`**. That tag is where anyone
reinstating Jellyfin starts from.

**The `jellyfin-ffmpeg` binary stays under its own name.** It is an
upstream package name (`/usr/lib/jellyfin-ffmpeg/`), pinned by SHA.
Renaming our references would only obscure where the binary comes from.
The final check (J4) allows exactly these references.

**Old data renders; it isn't migrated.**
- `ScanRun` rows of kind `JELLYFIN` and `AuditLog` rows such as
  `jellyfin-client.register` and `user.adult-library-access` (the latter's
  Jellyfin detail) remain readable.
- `/admin` shows them under a generic "Removed feature" label rather than
  crashing on an unknown kind.
- No rows are deleted.

**The native contract is renamed last, and separately.** Everything
server-side can go in two deploys. The `/jf/*` URLs and `features.jellyfin`
can only go once every installed iOS and tvOS build speaks the new names.
That is an app release and a `minAppBuild` bump, so it is its own phase and
does not block anything else.

### What goes

| Area | Removed |
|---|---|
| Playback proxy | `src/lib/jellyfin-playback.ts` and its test; the Jellyfin branches of `jf-routes.ts` (49-100, 113-119, 134-143); `engine-flag.ts` and its test; `uhdGate` if nothing else calls it; the `JELLYFIN_MAX_SESSIONS` fallback (`playback/engine.ts:87`); `PLAYBACK_ENGINE`; the `jellyfinId` filter in `film-user-state.ts:196-200` |
| Library sync | `src/lib/jellyfin.ts` and `jellyfin.test.ts`; `/api/jellyfin-sync`; `triggerJellyfinSync()` in the scanner (`scanner.ts:689-696, 799, 958`); the "Jellyfin relink" step and dependency in `scheduler.ts` and its test; `JELLYFIN` from `RunKind`, `ALL_KINDS` and `RUN_KINDS` (kept only in the "removed kinds" label map); the relink card in `ScanControls`; the Jellyfin rows on `/admin` |
| Adult coupling | `syncJellyfinAdultAccess`, `retryJellyfinAdultSync` and `publicSyncResult` in `actions/adult.ts`; the "waiting for your first Jellyfin sign-in" and "sync failed" states in `AdultAccessToggle`; `initiallyLinked` on `/account`; the deep link on `adult/[id]/page.tsx` (21-38, 98-108) |
| Viewer | `jf-viewer.ts` becomes `playback/viewer.ts`: `currentViewer` loses `jellyfinUserId` and `linkJellyfinUserId`, and `jellyfinItemFor*` are deleted; `jellyfinDeviceId` becomes `playbackDeviceId` with an **identical body** |
| OIDC provider | `jwt()` and `oauthProvider()` in `auth.ts`; `/consent` and `actions/consent.ts`; `oauthQuery` handling in `signin/page.tsx`, `OTPForm.tsx` and `auth-flow.ts`, including the branches that skip the passkey button and nudge for SSO; `registerJellyfinClient` and `JellyfinClientForm`; `/consent` from `CHROMELESS_PATHS` (`/device` stays); `@better-auth/oauth-provider` from `package.json` |
| Schema | Columns `Version.jellyfinId`, `EpisodeFile.jellyfinId`, `Scene.jellyfinId`, `User.jellyfinUserId`; models `Jwks`, `OauthClient`, `OauthResource`, `OauthClientResource`, `OauthRefreshToken`, `OauthAccessToken`, `OauthConsent`, `OauthClientAssertion`, and their back-relations on `User` and `Session` |
| Config | `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_*_PREFIX` (×4), `ADULT_JELLYFIN_FOLDER_ID`, `JELLYFIN_MAX_SESSIONS`, `PLAYBACK_ENGINE` and `IN_APP_PLAYBACK` from `.env.example`, `.env.docker.example`, `docker-compose.yml` and `scripts/e2e-*.ts` |
| Docs | README (the "Jellyfin" section, the SSO bullet in "Households", the stack line, the `curl /api/jellyfin-sync` recipe, "Playback"); DEPLOYMENT.md (`JELLYFIN_URL`, the 8096 firewall rule, the SSO section, the `jellyfin.markrwatts.com` Caddy site and ACME record, the JWKS note in backups); a "historical" banner on PLAN.md's Jellyfin sections, PLAYBACK_PLAN.md "Status", HOUSEHOLDS_PLAN.md "Jellyfin SSO" and IOS_PLAN.md's video section; PASSKEYS_PLAN.md phase 5 marked cancelled; test B4 removed from [TEST_PLAN_2026-09.md](docs/TEST_PLAN_2026-09.md) |
| Stale comments | The references to `scripts/register-jellyfin-client.ts`, which no longer exists, in `auth.ts` and `consent/page.tsx`; Jellyfin comments in `request-network.ts`, `uhd-gate.ts`, `video-playback.ts`, `parse.ts`, `parse-tv.ts`, `age-gate.ts`, `theporndb.ts`, `source.ts`, `engine-routes.ts`, `engine.ts` and `next.config.ts` |

### Phases

| # | Work | Est. |
|---|---|---|
| J0 | Groundwork: nothing removed yet | 0.5 day |
| J1 | Remove playback, sync, policy sync and the deep link | 2 days |
| J2 | Remove the OIDC provider | 1 day |
| J3 | Infrastructure and docs; switch the server off | 0.5 day |
| J4 | Rename the native contract, then run the final check | 1 day + app releases |

#### J0. Groundwork

- **Engine default:** `playbackEngine()` and compose default to `local`, to
  match production.
- **Device id:** move `jellyfinDeviceId()` to
  `src/lib/playback/viewer.ts` as `playbackDeviceId()`, with the same body.
  Every engine session keys on it, so a different derivation would orphan
  live sessions on deploy.
- **Run summaries:** `getLatestRuns` returns a map keyed by kind instead of
  indexing `ALL_KINDS` by position (`runs[8]` is Jellyfin). Removing a kind
  must not shift the others.
- **Removed kinds:** add the "removed kinds" label map so historical
  `JELLYFIN` rows still render.
- **Tag** `jellyfin-final` on the merge commit of J0.

#### J1. Remove playback, sync, policy sync and the deep link

- Everything in the table above except the OIDC and native-contract rows.
- One migration drops the four `jellyfin*` columns. SQLite rebuilds
  `Version`, `EpisodeFile`, `Scene` and `user`. Check it against a copy of
  the production database first, as the two earlier `user` rebuilds were,
  and take a backup at deploy.
- `jf-routes.ts` keeps only the engine path. It is renamed
  `playback/routes.ts`, and the `/jf/*` route files become one-line
  re-exports of it.
- **After this deploys, nothing MediaVault does touches the Jellyfin
  server.** Remove `JELLYFIN_*` from production's env the same day.

#### J2. Remove the OIDC provider

- The OIDC rows of the table above, and one migration that drops `jwks`
  and the seven `oauth*` tables.
- **Guard against collateral damage.**
  - `deviceAuthorization`, `bearer()`, email OTP and passkeys are all in
    the same `plugins` array in `auth.ts`.
  - The existing tests for device sign-in (`device-sign-in.test.ts`),
    passkeys, OTP and `session-cookie` must pass unchanged.
  - Run `scripts/e2e-passkey.ts` by hand, and complete a TV QR sign-in on
    real hardware before release.
- A stale `/signin?…oauth_query=…` link, such as a Jellyfin bookmark,
  behaves as a plain sign-in and never errors.

#### J3. Infrastructure and docs; switch the server off

- Docs, as in the table.
- **`ansible-homelab`**, its own change:
  - remove the `jellyfin.markrwatts.com` Caddy site and the
    `_acme-challenge.jellyfin` record;
  - remove the 192.168.6.53 → 192.168.1.11:8096 firewall rule;
  - retire `roles/jellyfin` and `jellyfin-vm`.
- Stop the server. Keep a Proxmox backup until J1 and J2 have run in
  production for a week, then delete it.

#### J4. Rename the native contract, then run the final check

1. **Server:** add `…/play/{session,stop,e/<key>/…}` beside `…/jf/*`, both
   served by `playback/routes.ts`, and `features.playback`, which already
   exists. Engine playlists hand out `play/` URLs.
2. **Apps:** MediaVaultKit, iOS and tvOS switch to `play/*` and read
   `features.playback` only. Ship through TestFlight.
3. **Server, once every household device runs that build:** raise
   `MIN_APP_BUILD`. Then delete:
   - the `/jf/*` route files;
   - `features.jellyfin`;
   - the `JF_PATH_RE` name.

   Rename `PlaybackSource "jellyfin"` to `"session"` in `VideoPlayer.tsx`
   and its callers.
4. **Final check:** a CI test runs `git grep -il jellyfin`. The only files
   it may match are:
   - the `jellyfin-ffmpeg` references (`Dockerfile`, `ffmpeg-bin.ts`,
     `head-args.ts` and their tests);
   - `prisma/migrations/**`;
   - the historical plan documents;
   - the "removed kinds" label map.

   Anything else fails the build, so Jellyfin cannot creep back in by
   accident.

---

## Part 2 — Adult as a module

### What "clean" means

A clean build is what a reviewer, a demo server or anyone else outside the
household would run. It must contain:

- **no Adult routes.** They don't exist in the route manifest and answer
  404 because there is no route, not because a check refused;
- **no Adult UI.** No nav item, account toggle, admin row or ThePornDB
  integration row;
- **no Adult code in the bundle.** The scanner, ThePornDB client, pages
  and components are not compiled in, and no Adult strings appear in
  `.next/`;
- **no Adult types.** The generated Prisma client has no `Scene`,
  `Performer` or `Studio`;
- **no Adult settings.** `ADULT_PATH`, `ADULT_IMAGE_CACHE_DIR` and
  `THEPORNDB_API_KEY` are neither read nor documented in the clean env
  template.

The **full** build is today's app, with Adult delivered through the module:
- scanning;
- ThePornDB enrichment and image cache;
- the nightly metadata step;
- engine playback;
- per-member opt-in with the date-of-birth rule;
- the owner's `/admin` on/off switch.

Two things are shared, deliberately:

- **The migration history.** Prisma has one migrations folder, so a clean
  install still creates the Adult tables, which stay empty. The SQL files
  name them. Splitting migrations per module was considered and rejected:
  Prisma cannot apply two histories to one database, and a hand-rolled
  second runner is a large cost for tables that hold nothing.
- **The source repository.** A clean *build* does not make the *repository*
  clean. If the public source ever needs to be clean too, see Later: the
  boundary rules make moving the module to a private repository mechanical.

### Three layers

A module is live only when all three agree. Everything reads the result
through one function, `isModuleEnabled(id)`.

| Layer | Set by | Effect when absent |
|---|---|---|
| **Built in** | `MEDIAVAULT_MODULES=adult` at **build** time, a Docker build argument | The code, routes, UI and client types don't exist. |
| **Configured** | The module's `requiredEnv` at runtime (`ADULT_PATH`) | `/admin` shows the module as misconfigured, names the missing variables and disables its switch. |
| **Enabled** | The owner's switch under Extensions on `/admin`, stored in `ModuleSetting` and audit-logged | Its routes 404, its nav and slots vanish, its jobs skip, and its engine sessions stop. Its data is kept. |

- **Defaults.** No `ModuleSetting` row counts as **off**. The upgrade
  migration writes `adult = on` only if the database already has scenes or
  opted-in members, so the household's library doesn't disappear on
  deploy.
- **Switching on grants nobody access.** Each member still opts in on
  `/account`, and anyone with a date of birth on record is still refused.

### Build-time mechanism

The App Router finds routes from the file system, so leaving a module out
has to happen before `next build` runs.

- **Route files use a module suffix:** `page.adult.tsx`, `route.adult.ts`.
  `next.config.ts` builds `pageExtensions` from `MEDIAVAULT_MODULES`:
  `["tsx", "ts", "adult.tsx", "adult.ts"]` in a full build, and only
  `["tsx", "ts"]` in a clean one. Next then doesn't see Adult routes at
  all. They stay at their current URLs (`/adult`, `/api/adult-video/…`,
  `/api/adult-image/…`).
  - Check first, in Next 16's docs (`node_modules/next/dist/docs/`), that
    `pageExtensions` still applies to the App Router under Turbopack in
    this version.
  - The fallback is a prebuild step that copies a module's route files into
    `src/app` from `src/modules/adult/routes/`, with the copies
    git-ignored.
- **The registry is generated.** `scripts/gen-modules.ts` runs as
  `prebuild` and `predev`. It writes `src/modules/registry.generated.ts`,
  which statically imports only the built-in modules' manifests. Nothing
  else in core imports a module, so an excluded module's code is never
  reached by the bundler.
- **The Prisma schema is assembled.** The schema becomes a folder:
  `prisma/schema/core.prisma` plus
  `src/modules/adult/schema.prisma`. The same script copies core and the
  built-in modules' schemas into `prisma/.build/`, which is git-ignored,
  and `prisma.config.ts` points `schema` at it. `prisma generate` then
  produces a client with or without `Scene`.
  - **Migrations** are still authored against the *full* schema, and
    `prisma migrate dev` refuses to run in a clean build.
- **Two images, one Dockerfile.** CI builds `mediavault:<version>` (with
  `MEDIAVAULT_MODULES=adult`) and `mediavault:<version>-clean` (empty).
  Production runs the full image; a review or demo server runs the clean
  one.

### The seam

Sized for the one module there is; add a hook only when a real second
module needs it.

```
src/modules/
  types.ts                the manifest and hook types (core-owned)
  registry.generated.ts   written by scripts/gen-modules.ts, git-ignored
  registry.ts             isModuleEnabled(), contributions(), the cache
  events.ts               typed lifecycle events (onUserDeleted, …)
  adult/
    manifest.ts
    schema.prisma
    server/…              scanner, ThePornDB enricher, queries, actions,
                          access rules, the media-source loader
    ui/…                  page bodies, AdultScenes, AdultPlayButton,
                          AdultAccessToggle
    routes/…              only if the pageExtensions fallback is needed
    README.md             env, tables, routes, and how to build without it
```

| Hook | Replaces | Core consumer |
|---|---|---|
| `libraries` | `SCENE` in `SCAN_MEDIA_TYPES`, `SCAN_KIND`, `SCAN_RUNNER` and `SCAN_PATH_ENV` (`scanner.ts:1287-1313`); `ENRICH_STARTER.SCENE` (`scheduler.ts:44`); `SCAN_SCENE` and `ENRICH_SCENE` in `runs.ts` and `constants.ts`; the Adult row and ThePornDB hint in `ScanControls`; `/api/scan/scene` and `/api/enrich/scene` | scanner, scheduler, runs, `/admin` |
| `mediaSources` | `"scene"` in `MediaKind` (`playback/types.ts:37`), `KINDS` and `STREAM_KEY_RE` (`stream-key.ts`), `KeyframeKind`, `loadRow`'s fall-through (`source.ts:205-209`), `mediaRootEnv`'s `ADULT_PATH` case, `ffprobe.ts`'s root list | the engine and probing |
| `nav` | `ADULT_ITEM` and `hasAdultAccess` (`nav-items.ts`, `app-shell.tsx:74-86`) | `navItemsFor` |
| `accountSections` | the inline `AdultAccessToggle` and its copy on `/account` | `/account` |
| `integrations` | the ThePornDB row on `/admin` | `/admin` |
| `ageGate` | `if (kind === "scene") return false` (`age-gate.ts:70`) | `canPlay` |
| `on.userDeleted` | a relation back to `User` | removing the member's `AdultAccess` row |

**Rules that keep the clean build clean:**

- **Core never names a module.** ESLint `no-restricted-imports` forbids
  `@/modules/*` everywhere except `src/modules/registry.ts`, and forbids
  the string literal `"scene"` outside `src/modules/adult`. A module may
  import core; it may not import another module.
- **`/api/v1` never asks the registry for anything.** Code under
  `src/app/api/v1` and `api-v1-types.ts` may not import `@/modules/*` at
  all, so the native API is identical in both builds by construction.
- **No columns on core models.** `User.adultLibraryAccess` becomes an
  `AdultAccess(userId TEXT PRIMARY KEY, grantedAt DATETIME)` table in the
  module's schema. It has **no Prisma relation**, because a relation would
  need a back-field on `User` in core. It is cleaned up through
  `on.userDeleted`. `KeyframeIndex.kind` and `InterlaceCheck.kind` are
  already plain strings, so `scene` rows need nothing.
- **The stream-key pattern is built from built-in kinds** when the module
  loads. It stays anchored and strict: in a clean build `scene-…` keys fail
  the syntax check, and in a full build the shim checks whether the module
  is enabled on each request.
- **The runtime switch is read per request.** Nav, slots, the scheduler
  tick, `canPlay` and every Adult route call `isModuleEnabled`, which reads
  a process-local cache. The switch invalidates the cache, and the cache
  re-reads the table every 60 s in case a script has changed it. MediaVault
  runs as one container, so no wider coordination is needed.

### Gating, kept intact

The module moves the existing rules; it does not relax any of them.

- **Adult content is seen only when all of these hold:**
  - the module is built in and enabled;
  - the member has an `AdultAccess` row;
  - the member has no date of birth
    (`require-member.ts:198-212`, `app-shell.tsx:86`).
- **Clearing a date of birth never re-grants access**
  (`household.ts:450`).
- **`ageGate` still refuses `scene`** to any restricted viewer, as the
  belt to the route guards' braces.
- **`requireAdultAccessOr{Redirect,Response}`** move into the module and
  stay in `route-guards.test.ts`'s accepted guards.
- **The blurred-poster preference** (`AdultScenes`, localStorage) moves
  unchanged.

### Phases

| # | Work | Est. |
|---|---|---|
| A1 | Seam, generated registry, runtime switch, schema assembly (no behaviour change) | 3 days |
| A2 | Move Adult into the module and onto the engine | 3 days |
| A3 | Clean build: `pageExtensions`, two images, the clean-build check in CI | 1.5 days |
| A4 | App Store review instance | 0.5 day |

#### A1. Seam

- `src/modules/{types,registry,events}.ts`, `scripts/gen-modules.ts`, and
  the `prebuild` and `predev` hooks.
- The schema folder and `prisma/.build/` assembly. `prisma migrate diff`
  against production shows only the new `ModuleSetting` table.
- The Extensions section on `/admin`, with owner-only switches and audit
  rows.
- Core consumers read contributions from the registry: scanner, scheduler,
  runs, stream keys, `loadRow`, nav, `/account` slots, `/admin`
  integrations and `canPlay`.
- The lint rules.
- Snapshot tests show nav, runs and stream keys are byte-identical before
  and after.

#### A2. Move Adult into the module and onto the engine

- **Code:** move every Adult file listed under "Where things stand" into
  `src/modules/adult/`, and rename its route files to `*.adult.tsx` and
  `*.adult.ts`.
- **Schema:** move `Scene`, `Performer`, `Studio` and `ScenePerformer` into
  the module's schema unchanged, apart from the `jellyfinId` column J1 has
  already dropped.
- **Access data:** add `AdultAccess`, and copy
  `user.adultLibraryAccess = 1` into it. Keep writing both for one release
  so a rollback finds the column correct. Drop the column in the release
  after.
- **Playback onto the engine**, which retires the last caller of
  `video-cache.ts` for scenes:
  - the module registers `mediaSources: [{ kind: "scene", … }]`;
  - `/api/adult-video/[sceneId]/{session,stop,[...path]}` are served by the
    engine behind `requireAdultAccessOrResponse`;
  - `AdultPlayButton` uses the session player with `trackProgress={false}`,
    as today;
  - verify seek, the Remote variant and direct play of MP4 scenes before
    deleting the five old routes.
- **Remove `scene` from core** unions, comments and `.env` templates. The
  Adult variables move into the module's README and a
  `.env.adult.example`.

#### A3. Clean build

- `pageExtensions` wiring, or the copy fallback.
- **CI builds both images and, for the clean one, checks that:**
  - `app-paths-manifest.json` and `app-build-manifest.json` contain no
    `/adult` or `/api/adult-` paths;
  - `grep -ri` across `.next/` finds none of the markers `theporndb`,
    `adult-video`, `adult-image`, `ScenePerformer` or `adultLibraryAccess`;
  - the generated Prisma client has no `Scene`, `Performer` or `Studio`
    model;
  - a smoke boot answers 404 on `/adult` and `/api/adult-image/x`, the
    `/admin` Extensions list is empty, and `/api/v1/me` matches the full
    build's response.
- **In the full image:** the module on/off matrix. Check nav, `/adult`,
  the image route, a scene session, the scanner tick and `/api/v1/me`, and
  that an age-restricted member with an `AdultAccess` row is refused
  everywhere.

#### A4. App Store review instance

Run a second container from the `-clean` image, on its own hostname:
- a small demo library of public-domain films and music on its own share;
- a single-member household with a demo account for App Review;
- no access to the household's database or NAS paths.

The iOS and tvOS review notes point at that instance.
[IOS_PLAN.md](IOS_PLAN.md) "TestFlight, internal testers" is updated:
unlisted distribution becomes feasible, because the reviewer never sees the
household's server.

---

## Order and effort

| Order | Phase | Est. |
|---|---|---|
| 1 | J0 Groundwork | 0.5 day |
| 2 | J1 Remove playback, sync, policy sync, deep link | 2 days |
| 3 | J2 Remove the OIDC provider | 1 day |
| 4 | J3 Infrastructure, docs, server off | 0.5 day |
| 5 | A1 Seam | 3 days |
| 6 | A2 Adult into the module and onto the engine | 3 days |
| 7 | A3 Clean build | 1.5 days |
| 8 | A4 Review instance | 0.5 day |
| — | J4 Native contract rename | 1 day + app releases, whenever the apps next ship |

That is about 12 days, plus J4.

- **Jellyfin goes first.** It is mostly deletion, and it removes the
  Jellyfin coupling from the Adult code before that code moves, so A2
  moves less.
- **J4 is independent.** It waits only on an app release.
- **Release as 4.0.0** after J2. Release as **4.1.0** after A3, the first
  release to ship a `-clean` image.

## Risks

- **Positional run indexing.** Fixed in J0, before any kind is removed.
- **Engine device ids.** `playbackDeviceId` must derive exactly as
  `jellyfinDeviceId` did, or live sessions are orphaned on deploy.
- **Collateral damage in `auth.ts`.** Device sign-in, bearer tokens,
  passkeys and OTP share the plugin list with the provider being removed.
  J2 runs their tests and an on-hardware TV sign-in before release.
- **SQLite table rebuilds.** J1 rebuilds four tables, including `user`.
  Test against a copy of production and take a backup at deploy.
- **`pageExtensions` under this Next version.** Confirm it first, as
  AGENTS.md asks. The copy-into-`src/app` fallback is ready if not.
- **Something in core naming Adult.** The lint rules, the `"scene"`-literal
  rule and the CI marker grep over the clean build each catch a different
  way it could slip back in.
- **A runtime switch read once and cached.** That would read as a leak:
  Adult still visible after the owner switched it off. Every read goes
  through `isModuleEnabled`, and the full-image matrix flips the switch
  within one process.

## Later

- **A clean repository, not just a clean build.** Move `src/modules/adult/`
  to a private repository, pulled in as a git submodule, or as a private
  package the full Docker build installs. The boundary rules mean this is a
  folder move plus a build step. Worth doing only if the source is ever
  published or shared.
- **A second module.** Concerts (already half-separate via `Film.kind`) or
  the barcode Scan companion are the likely candidates. Add hooks then, not
  now.
