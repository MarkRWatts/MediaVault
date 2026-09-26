# MediaVault — deprecating Jellyfin, and an extension seam to put it behind

The goal: **Jellyfin stops being part of MediaVault's core**, without
throwing away the option of bringing parts of it back. The same seam is used
to move the Adult media type out of core too, so that both become optional
modules that can be switched on, switched off, or deleted without surgery
across the codebase.

This plan picks up where [V4_PLAN.md](V4_PLAN.md) "Removing Jellyfin" and
phase 6 left off, and replaces them where the two disagree.

## Status (26 Sep 2026)

Planning only. Nothing below is implemented yet.

## Where things stand

- **Production no longer plays through Jellyfin.** The VM has run
  `PLAYBACK_ENGINE=local` with `PLAYBACK_HWACCEL=vaapi` since 20 Sep
  ([UHD_PLAN.md](UHD_PLAN.md) "Measured"). The code, though, still defaults
  to `jellyfin` (`src/lib/playback/engine-flag.ts:29`,
  `docker-compose.yml:69`). V4 phase 5 (verification) and phase 6 (removal)
  are marked "Not started". V4_PLAN's status line ("On branch v4, not
  deployed") is out of date.
- **What Jellyfin still does in production:**
  1. **Library sync** (`src/lib/jellyfin.ts`, about 740 lines). After every
     film and TV scan, and in the nightly scheduler tick, it matches files to
     Jellyfin items and writes `jellyfinId` onto `Version`, `EpisodeFile` and
     `Scene`. Under the local engine nothing reads those ids for film or TV
     playability. The only live consumer is the "Play in Jellyfin" deep link
     on the Adult scene page.
  2. **Adult-library policy sync.** Ticking the Adult opt-in on `/account`
     calls `syncJellyfinAdultAccess`, which edits that member's Jellyfin
     `Policy.EnabledFolders` (`src/app/actions/adult.ts`,
     `AdultAccessToggle.tsx`).
  3. **Jellyfin SSO.** MediaVault acts as an OIDC provider for
     jellyfin-plugin-sso (`src/lib/auth.ts:184-206`, `/consent`, the
     `oauthQuery` path through `/signin` and `OTPForm`,
     `registerJellyfinClient` and `JellyfinClientForm`). Here Jellyfin
     depends on MediaVault, not the other way round.
- **Jellyfin in name only (kept):**
  - The `jellyfin-ffmpeg` build in the `Dockerfile`, `ffmpeg-bin.ts` and
    `head-args.ts`. It is our transcoder binary, not the server.
  - The `/jf/session`, `/jf/stop` and `/jf/e/<key>/…` URL shapes. The iOS
    app speaks these, and they already serve from the engine.
  - `PlaybackSource = "jellyfin"` in `VideoPlayer.tsx`, which names the
    session protocol both engines speak.
- **The Adult media type is wired into roughly 60 files.** It has:
  - its own models (`Scene`, `Performer`, `Studio`, `ScenePerformer`);
  - `User.adultLibraryAccess`;
  - a `SCENE` entry in every scanner and run table;
  - a `scene` member in both playback `MediaKind` unions;
  - hard-coded nav, account and admin rows;
  - its own playback routes on the **old, parked** `video-cache.ts`
    pipeline, not the engine.

  Its design notes live in the untracked `ADULT_PLAN.md`. This document
  keeps to structure and does not repeat them.

## Decisions

**Delete Jellyfin playback outright; don't turn it into an extension.** The
proxy path (`jellyfin-playback.ts`, the Jellyfin branches of `jf-routes.ts`,
the `jellyfin` value of `PLAYBACK_ENGINE`) is strictly worse than the
engine. It gives no direct play, no HEVC decision and no per-member session
cap that we control, and nothing depends on it. Keeping it as a pluggable
"playback backend" would mean designing and testing an abstraction for a
path we never want to take again. If it is ever wanted, the code is at the
`jellyfin-final` tag (below).

**Move the rest of Jellyfin into a `jellyfin` extension that is off by
default.** That is:
- library sync, rewritten to use extension-owned link tables (below);
- the deep link;
- the adult-policy sync;
- the admin relink card.

It is cheap to keep because it only reads the library and calls an HTTP
API, and it is exactly what a future "sync watch state with Jellyfin"
([PLAN.md](PLAN.md) backlog) would build on.

**Generalise the OIDC provider in core rather than move it.** The provider,
`/consent` and the `oauthQuery` sign-in path are generic BetterAuth and OAuth
machinery. Only the admin form and a few labels say "Jellyfin". Rename them
to "Trusted OAuth clients" and keep them in core, gated by an
`OIDC_PROVIDER` switch that is on while the household's Jellyfin server is.
Moving auth plumbing into an extension would put an extension on the
sign-in path. That is the one place where a disabled or broken module must
not be able to change behaviour.

**Extensions are compile-time modules, switched on at runtime.** The App
Router discovers routes from the file system at build time, so there is no
honest way to load code that isn't in the build. An extension is:
- a folder in the repository (`src/extensions/<id>/`);
- a manifest registered statically in one file;
- turned on by `MEDIAVAULT_EXTENSIONS`.

"Deleting" an extension means removing its folder and its route shims.
The boundary rules below make that a clean deletion.

**A disabled extension keeps its data.** Its tables stay migrated and are
left alone. Its routes answer 404, its nav, account and admin
contributions disappear, and its jobs don't run. Turning it back on is a
config change, with no restore step.

**Extensions never add columns to core models.** Prisma cannot split one
model across files, and a column on `Version` or `User` is exactly the kind
of coupling this plan exists to remove. An extension owns side tables keyed
by the core row's id:
- `jellyfinId` on three models becomes a `JellyfinItemLink` table;
- `User.jellyfinUserId` becomes `JellyfinUserLink`;
- `User.adultLibraryAccess` becomes `AdultAccess`.

These tables hold a plain `userId` or `(kind, localId)` with **no Prisma
relation**, as `KeyframeIndex.kind` does today, because a relation needs a
back-field on the core model. Cleanup on delete goes through a core
lifecycle hook (`onUserDeleted`, `onMediaRemoved`) rather than an
`ON DELETE CASCADE`.

## The extension seam

### Layout

```
src/extensions/
  types.ts            the manifest and hook types (core-owned, the only
                      import extensions may take from src/extensions)
  registry.ts         static list of every manifest + enabled() filtering
  events.ts           the tiny typed event bus (below)
  adult/
    manifest.ts
    server/…          scanner, ThePornDB enricher, queries, actions
    ui/…              pages' bodies, AdultScenes, AdultPlayButton, toggle
    README.md
  jellyfin/
    manifest.ts
    server/…          sync, API client, policy sync, deep link
    ui/…              relink card, integration row
    README.md
prisma/schema/
  core.prisma         today's schema.prisma, minus the adult models
  ext-adult.prisma
  ext-jellyfin.prisma
```

`prisma.config.ts` points `schema` at the `prisma/schema` folder. Prisma 7
reads multi-file schemas natively. There is still one migration history.
Enabling an extension never runs a migration, which is why a disabled
extension's tables still exist.

### Enabling

- `MEDIAVAULT_EXTENSIONS=adult,jellyfin` is an explicit, comma-separated
  list. The default is empty.
- On boot, each manifest's `requiredEnv` is checked
  (`ADULT_PATH`, `JELLYFIN_URL` and so on). An enabled extension with
  missing config is loaded but marked **misconfigured**. It shows on
  `/admin` with the missing variables named, which is today's behaviour for
  unset library paths, and contributes nothing else.
- For one release, adult is enabled implicitly when `ADULT_PATH` is set,
  with a deprecation warning, so the upgrade needs no `.env` edit.

### The manifest

```ts
export interface Extension {
  id: string;                         // "adult", "jellyfin"
  name: string;
  requiredEnv: string[];
  // Contributions — every field optional.
  libraries?: LibraryContribution[];  // scan + enrich + run kinds
  mediaSources?: MediaSourceContribution[]; // engine playback kinds
  nav?: NavContribution[];
  accountSections?: SlotContribution<"account">[];
  adminSections?: SlotContribution<"admin">[];
  integrations?: IntegrationStatus[]; // the /admin "Integrations" rows
  jobs?: JobContribution[];           // post-scan and scheduler steps
  ageGate?: AgeGateContribution[];    // canPlay() for its own kinds
  apiV1Features?: (viewer) => Record<string, boolean>;
  on?: Partial<EventHandlers>;        // lifecycle + cross-extension events
}
```

Each hook replaces a hard-coded list that exists today:

| Hook | Replaces | Core consumer |
|---|---|---|
| `libraries` | `SCAN_MEDIA_TYPES`, `SCAN_KIND`, `SCAN_RUNNER`, `SCAN_PATH_ENV` (`scanner.ts:1287-1313`); `ENRICH_STARTER` (`scheduler.ts:40`); `RunKind` and positional `ALL_KINDS` (`runs.ts`); `RUN_KINDS` (`constants.ts:38`); the library rows in `ScanControls` | scanner, scheduler, runs, `/admin`, `/api/scan/*`, `/api/enrich/*` |
| `mediaSources` | `MediaKind = "film" \| "scene" \| "episode"` (`playback/types.ts:37`), `KINDS` and `STREAM_KEY_RE` (`stream-key.ts`), `loadRow`'s fall-through (`source.ts:179-209`), `mediaRootEnv` | the engine |
| `nav` | `ADULT_ITEM` and `NavFlags.hasAdultAccess` (`nav-items.ts`) | `navItemsFor` and `app-shell` |
| `accountSections` / `adminSections` | the inline `AdultAccessToggle` and `JellyfinClientForm` blocks | `/account` and `/admin` render the slot list |
| `integrations` | the ThePornDB and Jellyfin rows on `/admin` | `/admin` |
| `jobs` | `triggerJellyfinSync()` after scans (`scanner.ts:689-696`); the "Jellyfin relink" step (`scheduler.ts:98`) | scanner and scheduler |
| `ageGate` | `if (kind === "scene") return false` (`age-gate.ts:70`) | `canPlay` |
| `on` | the direct call from `toggleAdultLibraryAccess` to `syncJellyfinAdultAccess` | `events.ts` |

Notes on the harder ones:

- **Run kinds become strings namespaced by the extension**, such as
  `adult:SCAN` and `jellyfin:SYNC`. Core keeps `SCAN_FILM` and the rest.
  `getLatestRuns` returns a `Record<string, RunSummary>` instead of indexing
  `ALL_KINDS` by position, which is already a trap: `runs[8]` breaks if one
  kind is removed. Old `SCAN_SCENE`, `ENRICH_SCENE` and `JELLYFIN` rows stay
  readable through an alias map, so the history on `/admin` keeps rendering.
- **Engine media kinds.** The engine keeps its closed-set safety by having
  core build `STREAM_KEY_RE` once, at module load, from core kinds plus
  enabled `mediaSources` ids. Ids must match `/^[a-z]+$/`, which the
  registry asserts. The regex stays anchored and strict. It is just not
  hard-coded. `KeyframeIndex.kind` and `InterlaceCheck.kind` are already
  strings, so `scene` rows need no change.
- **Cross-extension events, not imports.** Adult emits
  `adult.accessChanged({ userId, granted })`. The Jellyfin extension
  subscribes and does the policy sync. Neither imports the other, so either
  can be enabled alone. The account toggle's "waiting for your first
  Jellyfin sign-in" and "sync failed" states move out of the adult toggle
  into a Jellyfin-contributed status line under it.

### Routes

The App Router needs real files under `src/app`, so every extension route
is a **shim** there. Each shim is about five lines: it checks
`requireExtension("adult")`, which calls `notFound()` or returns 404 when
the extension is disabled, then delegates to the extension module.

```
src/app/adult/page.tsx                  → extensions/adult/ui/ScenesPage
src/app/adult/[id]/page.tsx             → extensions/adult/ui/ScenePage
src/app/api/adult-image/[...path]/…     → extensions/adult/server/image
src/app/api/adult-video/[sceneId]/jf/…  → core engine routes, kind "scene"
src/app/api/ext/jellyfin/sync/route.ts  → extensions/jellyfin/server/sync
```

URLs stay as they are; `/adult` does not become `/ext/adult`. A route
file under a path the extension owns is listed in its manifest
(`routes: ["/adult", "/api/adult-image", …]`). A test checks that every
listed prefix has shims and every shim calls `requireExtension`, the same
kind of guarantee `route-guards.test.ts` gives for auth guards today.

A catch-all `/ext/[id]/[...path]` dispatcher was considered and rejected:
- it changes every URL;
- it defeats static rendering and per-route `export const` config;
- it moves security boundaries into a hand-written router.

### Boundary rules (lint-enforced)

ESLint `no-restricted-imports`:

- **Core** (`src/lib`, `src/components`, `src/app` except shims) may import
  from `src/extensions` **only** `registry.ts`, `types.ts` and `events.ts`.
- **An extension** may import core's public surface, which is `@/lib/*`,
  `@/components/*` and the generated Prisma client. It may not import
  another extension or a route file.
- **A shim** may import only its own extension and `@/extensions/registry`.

A unit test also imports each extension with it disabled, and asserts that:
- it contributes nothing;
- its shims 404;
- `navItemsFor`, `getLatestRuns` and the stream-key regex are identical to
  a build without it.

## Phases

| # | Work | Est. |
|---|---|---|
| 0 | Make the default match production | 0.5 day |
| 1 | Announce the deprecation | 0.5 day |
| 2 | Build the extension seam (no behaviour change) | 3 days |
| 3 | Adult → extension, and onto the engine | 3 days |
| 4 | Delete Jellyfin playback | 1.5 days |
| 5 | Jellyfin → extension, off by default | 2.5 days |
| 6 | OIDC provider: rename and gate | 1 day |
| 7 | Docs and the 4.0.0 release | 1 day |

Phases 0–1 can ship this week. Phase 2 must land before 3 and 5. Phases 3
and 4 are independent of each other. Phase 5 needs 4, because the sync must
stop feeding `isFilePlayable` before its columns move.

### 0. Make the default match production

- `playbackEngine()` defaults to `local`, as does compose
  (`PLAYBACK_ENGINE:-local`). `jellyfin` stays selectable for one more
  release as the escape hatch.
- Move `jellyfinDeviceId()` out of `jellyfin-playback.ts` into
  `src/lib/playback/viewer.ts` as `playbackDeviceId()`. `jf-viewer.ts`
  imports it for **every** engine session, so it must move before anything
  is deleted. Keep the derivation identical so live sessions survive the
  deploy.
- Replace positional indexing in `getLatestRuns` with a keyed map. This is
  a standalone fix and is needed by phases 2 and 4.
- Correct V4_PLAN's status: phase 5 is effectively done in production;
  phase 6 is superseded by this plan.

### 1. Announce the deprecation

- `/admin` shows a "Jellyfin integration is deprecated and will move to an
  optional extension in 4.0.0" note on the Jellyfin row whenever
  `JELLYFIN_URL` is set.
- Log one warning at boot for each of `JELLYFIN_URL`,
  `JELLYFIN_MAX_SESSIONS` and `PLAYBACK_ENGINE=jellyfin`.
- README: mark the "Jellyfin" section deprecated. The "What it does"
  entries on playback and SSO describe the engine.

### 2. Build the extension seam

Pure refactor. Core behaviour and URLs don't change, and adult and Jellyfin
stay where they are.

- `src/extensions/{types,registry,events}.ts`, with an empty registry.
- The Prisma schema becomes a folder (`prisma/schema/core.prisma`). There is
  no migration. Check that `prisma migrate diff` against the current
  database is empty.
- Core consumers read from the registry, with core's own entries as the
  first contributions:
  - scanner, scheduler and runs tables (`libraries`);
  - the stream-key regex and `loadRow` (`mediaSources`);
  - `navItemsFor`;
  - the `/account` and `/admin` slots;
  - `canPlay`;
  - `/api/v1/me` features.
- Film, TV, music and concerts remain core. They are registered through the
  same shapes so that the seam is exercised from day one, but they are not
  moved into `src/extensions`.
- Add the lint rules and the disabled-extension test harness.
- Add `requireExtension()` to `require-member.ts`'s family and to
  `route-guards.test.ts`'s accepted guards.

### 3. Adult → extension

- **Code:** move the adult files into `src/extensions/adult/`, leaving
  shims:
  - the scanner section (`scanner.ts:1116-1280`) and `theporndb.ts`;
  - the pages and `AdultScenes`;
  - `AdultPlayButton` and `AdultAccessToggle`;
  - `src/app/actions/adult.ts`;
  - the image route;
  - `currentAdultAccessUserId` and `requireAdultAccessOr*` from
    `require-member.ts`. They are re-exported through the extension, and
    their callers are all adult code.
- **Playback onto the engine.** This retires the last scene user of
  `video-cache.ts`, which V4 wants gone anyway:
  - Register `mediaSources: [{ kind: "scene", load, rootEnv: "ADULT_PATH" }]`.
  - Replace the five `/api/adult-video/[sceneId]/*` routes with
    `/api/adult-video/[sceneId]/jf/{session,stop,[...path]}` shims onto
    `engineSession`, `engineStop` and `engineProxy`, behind
    `requireAdultAccessOrResponse`.
  - `AdultPlayButton` switches to `source="jellyfin"` with
    `trackProgress={false}`, as today.
  - Verify seek, the Remote variant and direct play for MP4 scenes before
    deleting the old routes.
- **Schema:** move `Scene`, `Performer`, `Studio` and `ScenePerformer` into
  `prisma/schema/ext-adult.prisma` unchanged. Moving a model between files
  is not a migration.
- **Data migration.** Create `AdultAccess(userId TEXT PRIMARY KEY,
  grantedAt DATETIME)`, then:

  ```sql
  INSERT INTO AdultAccess(userId, grantedAt)
    SELECT id, CURRENT_TIMESTAMP FROM user WHERE adultLibraryAccess = 1;
  ```

  Drop `user.adultLibraryAccess` in a **later** migration, in phase 7, so a
  rollback to 3.x in between finds the column still correct. Until then,
  write both.
- **Rules that must not weaken:**
  - Access is granted only when an `AdultAccess` row exists **and** the
    member has no date of birth (`app-shell.tsx:86`,
    `require-member.ts:198-212`).
  - Clearing a date of birth never re-grants access
    (`household.ts:450`).
  - `ageGate` contributes `scene → false` for any restricted viewer.
- `/api/v1` remains free of adult data (App Store 1.1.4, see
  [IOS_PLAN.md](IOS_PLAN.md)). The adult manifest contributes no
  `apiV1Features`, and a test asserts that `/api/v1/me` looks the same with
  adult enabled and disabled.
- Remove `scene` from every core union and comment:
  - `playback/types.ts`, `stream-key.ts`, `keyframe-store.ts` and
    `video-cache.ts`;
  - `mediaRootEnv`'s `ADULT_PATH` fall-through;
  - `ffprobe.ts`'s root list, which takes the extension's `rootEnv`
    instead.

### 4. Delete Jellyfin playback

This is V4_PLAN's "Removing Jellyfin" list, with the sync split off:

- **Delete:**
  - `src/lib/jellyfin-playback.ts` and its test;
  - the Jellyfin branches of `jf-routes.ts` (lines 49-100, 113-119 and
    134-143);
  - `engine-flag.ts` and its test.
- **Simplify to the local engine's rules:**
  - `isFilePlayable` becomes "probed" (`videoCodec !== null`);
  - `playbackAvailable` is always true;
  - `film-user-state.ts:196-200` drops its Jellyfin filter.
- Rename `jf-routes.ts` to `playback/routes.ts`. `jf-viewer.ts` becomes
  `playback/viewer.ts` and loses `jellyfinUserId` and
  `jellyfinItemFor*`.
- `uhdGate` is only called from the Jellyfin branches. Delete it if nothing
  else uses it.
- Remove the `JELLYFIN_MAX_SESSIONS` fallback in `playback/engine.ts:87`.
- Remove `PLAYBACK_ENGINE` and `IN_APP_PLAYBACK` from the env templates and
  compose. Remove the "Engine" wording about Jellyfin from `/admin`.
- **Keep:**
  - the `/jf/*` URL shapes, the "jellyfin" `PlaybackSource` value and
    `features.jellyfin`. They are the native apps' contract, and dropping
    them is a `minAppBuild` bump, listed under Later;
  - the `jellyfin-ffmpeg` binary.
- Tag the commit before this phase `jellyfin-final`. That is where the
  proxy code lives if it is ever wanted.

### 5. Jellyfin → extension

- **Schema, `ext-jellyfin.prisma`:**
  - `JellyfinItemLink(kind TEXT, localId INT, itemId TEXT,
    PRIMARY KEY(kind, localId))`, where kind is `version`, `episodeFile`
    or `scene`;
  - `JellyfinUserLink(userId TEXT PRIMARY KEY, jellyfinUserId TEXT)`.
- **Migration:** copy the four existing columns into the link tables, then
  drop them from `Version`, `EpisodeFile`, `Scene` and `User`. SQLite
  rebuilds each table, so check it against a copy of the production
  database, as the two earlier `user` rebuilds were.
- **Code:** move `src/lib/jellyfin.ts` into
  `src/extensions/jellyfin/server/`:
  - The sync writes link rows instead of columns. Its safety guard
    (`shouldClearStaleIds`) and the NFC path normalisation come across
    unchanged, with their tests.
  - The adult pass runs only when the adult extension is enabled.
  - It is contributed as a `jobs` entry: after a scan of the kinds it
    links, and as a scheduler step.
  - Its run kind is `jellyfin:SYNC`, and old `JELLYFIN` rows alias to it.
- **UI:**
  - The relink card and the integration row are contributed to `/admin`.
  - The "Play in Jellyfin" deep link on the scene page becomes a
    `sceneActions` slot that the adult extension exposes and Jellyfin
    fills. The adult extension doesn't know Jellyfin exists.
- **Adult policy sync:** subscribes to `adult.accessChanged`.
  `resolveJellyfinUserId` and `linkJellyfinUserId` write
  `JellyfinUserLink`.
- `/api/jellyfin-sync` becomes a shim at the same URL, because the README's
  `curl` recipe uses it, and returns 404 when the extension is disabled.
- **Off by default.** Production turns it off at this release unless the
  household still wants the adult deep link. That is an open question,
  below.

### 6. OIDC provider: rename and gate

- `registerJellyfinClient` becomes `registerTrustedOAuthClient`, and
  `JellyfinClientForm` becomes `TrustedClientForm`. The audit event
  `jellyfin-client.register` gets a new name, and old rows still render.
- `OIDC_PROVIDER=on|off`. It defaults to `on` if a trusted client exists,
  so behaviour doesn't change. When it is off, the BetterAuth
  `oauthProvider` plugin isn't mounted, `/consent` returns 404, and
  `/signin` ignores `oauthQuery`.
- Fix the stale `scripts/register-jellyfin-client.ts` references in
  `auth.ts` and `consent/page.tsx`.
- [PASSKEYS_PLAN.md](PASSKEYS_PLAN.md) phase 5 (SSO via passkey) and test
  B4 in [TEST_PLAN_2026-09.md](docs/TEST_PLAN_2026-09.md) are unaffected.

### 7. Docs and release 4.0.0

- Drop `user.adultLibraryAccess` (see phase 3).
- **README:**
  - The stack line loses "Jellyfin".
  - "Playback" describes the engine.
  - A new "Extensions" section lists `adult` and `jellyfin`, what each
    needs and how to enable it.
- **DEPLOYMENT.md:**
  - The firewall rule for TCP 8096 is needed only with the Jellyfin
    extension.
  - The `jellyfin.markrwatts.com` Caddy site follows the OIDC decision.
- Mark as historical: PLAN.md, PLAYBACK_PLAN.md "Status", and
  IOS_PLAN.md's video section. V4_PLAN.md phase 6 points here.
- Each extension's `README.md` covers its env, tables, routes, events and
  how to delete it.
- Set `package.json` to 4.0.0.

## Reinstating Jellyfin later

| Want | Do |
|---|---|
| Deep links, adult policy sync, nightly relink | `MEDIAVAULT_EXTENSIONS=…,jellyfin`, set `JELLYFIN_URL` and `JELLYFIN_API_KEY`, press Relink on `/admin`. The link tables are repopulated from scratch, so nothing is lost. |
| Watch-state sync with Jellyfin | A new job in the Jellyfin extension, plus an `on.playbackProgress` event core would emit from `play-events.ts`. It fits the seam and needs no core change beyond the event. |
| Jellyfin as the playback backend again | Not supported by the seam on purpose. It would need a `playbackBackend` hook in `playback/routes.ts`; start from the `jellyfin-final` tag. |

## Testing

- Every phase keeps `npm run lint`, `typecheck` and `test` green, and runs
  `scripts/e2e-engine.ts` against a real ffmpeg.
- **Phase 2:** snapshot tests show that `navItemsFor`, the runs summary,
  the stream-key regex and `/api/v1/me` are byte-identical before and after
  the refactor.
- **Phase 3:**
  - An adult on/off matrix: nav, `/adult` (200 or 404), the image route,
    session, `/api/v1/me`, and the scanner tick.
  - An age-restricted member with an `AdultAccess` row is refused
    everywhere.
  - Engine playback of a scene: seek, the Remote variant, and stop.
- **Phase 5:**
  - The migration round-trips against a copy of the production database,
    and the link-table row counts equal the non-null column counts before
    the drop.
  - The existing `jellyfin.test.ts` cases, including the blocked-sweep
    guard, pass against link tables.
- **Phase 6:** SSO sign-in from Jellyfin still works with
  `OIDC_PROVIDER=on`. With it off, `/consent` returns 404.

## Risks

- **Positional run indexing.** Fixed in phase 0, before anything removes a
  kind.
- **Engine device ids.** If `playbackDeviceId` derives differently from
  `jellyfinDeviceId`, every live session is orphaned on deploy. Phase 0
  keeps the function body identical.
- **SQLite table rebuilds on `user`.** Two have happened before without
  incident. Test against a copy of the production database first, and take
  a backup at deploy.
- **The seam as over-engineering.** Two extensions justify it only if the
  hooks stay the ones listed. Add a hook when a third real extension needs
  it, not before.
- **Shims drifting from manifests.** Covered by the route-prefix test.

## Open questions

1. Is the household's Jellyfin **server** being retired, or only
   MediaVault's use of it? This decides whether `OIDC_PROVIDER` ships on,
   whether the Caddy site stays, and whether the Jellyfin extension is
   enabled in production at 4.0.0.
2. Is the adult "Play in Jellyfin" deep link still used, now that scenes
   will play in-app through the engine? If not, the Jellyfin extension can
   ship disabled everywhere.
3. `MEDIAVAULT_EXTENSIONS` as the only switch, or also a per-household
   toggle on `/admin`? Env-only is proposed: it is simpler, and there is
   one household.

## Later

- Retire the `/jf/*` aliases, the `"jellyfin"` `PlaybackSource` value and
  `features.jellyfin` with a `minAppBuild` bump, once every native build in
  the house speaks `play/*`.
- Candidates for the seam once it exists: Concerts (already half-separate
  via `Film.kind`), and the barcode Scan companion API.
