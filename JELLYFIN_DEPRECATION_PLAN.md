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

Decided 26 Sep 2026:

1. **The household's Jellyfin server is being retired**, not just
   MediaVault's use of it. So there is nothing left to link to, and no
   client left for the OIDC provider.
2. **The "Play in Jellyfin" button on Adult scenes goes.** Scenes play in
   the app through the engine instead.
3. **Extensions are switched on in two places.** The environment decides
   which are available, and the app owner turns each one on or off from
   `/admin` without a redeploy.

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

**Move the rest of Jellyfin into a `jellyfin` extension that ships
disabled everywhere, production included.** With the server retired this is
kept purely so Jellyfin can come back. The extension holds:
- library sync, rewritten to use extension-owned link tables (below);
- the adult-policy sync;
- the admin relink card.

The "Play in Jellyfin" deep link is **deleted, not moved** (decision 2).
The extension is cheap to keep because it only reads the library and calls
an HTTP API. It is exactly what a future "sync watch state with Jellyfin"
([PLAN.md](PLAN.md) backlog) would build on. Its tests run in CI against a
stubbed server, as `jellyfin.test.ts` does today, so it cannot rot unnoticed
while it has no server to talk to.

**Keep the OIDC provider code in core, generalised and switched off.** The
provider, `/consent` and the `oauthQuery` sign-in path are generic
BetterAuth and OAuth machinery. Only the admin form and a few labels say
"Jellyfin". Rename them to "Trusted OAuth clients" and keep them in core
behind an `OIDC_PROVIDER` switch. The switch **defaults to off** in 4.0.0,
because the server is retired (decision 1) and Jellyfin is the only client
it has ever had.
- Moving auth plumbing into an extension would put an extension on the
  sign-in path. That is the one place where a disabled or broken module
  must not be able to change behaviour.
- Deleting the provider outright was considered. Keeping it off costs
  little: the code is small, and BetterAuth owns its tables. It is also the
  piece a reinstated Jellyfin needs first for SSO.

**Extensions are compile-time modules, switched on at runtime.** The App
Router discovers routes from the file system at build time, so there is no
honest way to load code that isn't in the build. An extension is:
- a folder in the repository (`src/extensions/<id>/`);
- a manifest registered statically in one file;
- **made available** by `MEDIAVAULT_EXTENSIONS`, then **turned on or off**
  by the app owner on `/admin` (decision 3).

"Deleting" an extension means removing its folder and its route shims.
The boundary rules below make that a clean deletion.

**A disabled extension keeps its data.** Its tables stay migrated and are
left alone. Its routes answer 404, its nav, account and admin
contributions disappear, and its jobs don't run. Turning it back on is one
click on `/admin`, with no restore step.

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
  settings.ts         the owner's on/off state (ExtensionSetting), cached
  adult/
    manifest.ts
    server/…          scanner, ThePornDB enricher, queries, actions
    ui/…              pages' bodies, AdultScenes, AdultPlayButton, toggle
    README.md
  jellyfin/
    manifest.ts
    server/…          sync, API client, policy sync
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

Two layers, because the owner wants to switch extensions without a
redeploy but the environment still has to hold paths and API keys.

1. **Available.** `MEDIAVAULT_EXTENSIONS=adult,jellyfin` is an explicit,
   comma-separated list, empty by default. An extension missing from it
   doesn't appear anywhere, `/admin` included. That is how a household that
   never wants Adult content keeps it invisible even to the owner. For one
   release, adult is available implicitly when `ADULT_PATH` is set, with a
   deprecation warning, so the upgrade needs no `.env` edit.
2. **Configured.** Each manifest's `requiredEnv` (`ADULT_PATH`,
   `JELLYFIN_URL` and so on) is checked at boot. An available extension
   with missing config shows on `/admin` as **misconfigured**, with the
   missing variables named, which is today's behaviour for unset library
   paths. Its toggle is disabled and it contributes nothing.
3. **Enabled.** An on/off switch per extension in a new "Extensions"
   section on `/admin`, for the app owner only (`requireOwnerOrRedirect`).
   - Stored in a core table,
     `ExtensionSetting(id TEXT PRIMARY KEY, enabled BOOLEAN,
     updatedAt DATETIME, updatedBy TEXT)`.
   - Each change writes an `extension.enable` or `extension.disable`
     audit-log row.
   - With no row, an extension counts as **off**, so making one available
     never switches it on by itself. The one exception is the 4.0.0
     upgrade migration, which writes `adult = on` so the existing library
     doesn't disappear on deploy.

**The effective state is available ∧ configured ∧ enabled**, from
`isExtensionEnabled(id)` in `registry.ts`. Everything reads through that
one function, never the env or the table directly.

What a runtime toggle forces on the design:
- **Nothing may decide at module load.** Nav, slots, the scheduler tick,
  job hooks, `canPlay` and every shim ask `isExtensionEnabled` per
  request. It reads an in-memory cache that the toggle action invalidates.
  MediaVault runs as one container, so a process-local cache is
  sufficient; the cache also re-reads the table every 60 s, in case of a
  second process such as a script.
- **The stream-key regex is built from *available* kinds**, not enabled
  ones. It is a syntax check and stays fixed for the process's lifetime.
  Whether a `scene-…` key may be served is decided per request by the
  shim, which 404s when adult is off.
- **Switching an extension off mid-use:**
  - Its engine sessions are stopped through the engine's existing session
    registry, so a playing scene ends within one segment rather than when
    the head finishes.
  - A running scan or sync is allowed to finish.
  - Its pages 404 on the next navigation.
  - `revalidatePath("/", "layout")` refreshes the nav, as the Adult opt-in
    already does.
- **Switching on** runs nothing by itself. The next scheduler tick picks it
  up, or the owner presses the library's Scan button.
- **A member's own opt-in is still required.** Turning Adult on for the
  house does not grant anyone access. `AdultAccess` and the
  no-date-of-birth rule still decide per member.

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
| `accountSections` / `adminSections` | the inline `AdultAccessToggle` block and the Jellyfin relink card (`JellyfinClientForm` stays in core as the Trusted OAuth clients form, phase 6) | `/account` and `/admin` render the slot list |
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

A unit test runs each extension through all three states: not available,
available but switched off, and on. With it unavailable or off, it asserts
that:
- it contributes nothing;
- its shims 404;
- `navItemsFor` and `getLatestRuns` are identical to a build without it.

A further test flips the `/admin` switch within one process and checks
that nav, shims and `canPlay` follow on the next request, with no restart.

## Phases

| # | Work | Est. |
|---|---|---|
| 0 | Make the default match production | 0.5 day |
| 1 | Announce the deprecation | 0.5 day |
| 2 | Build the extension seam and the `/admin` switches (no behaviour change) | 4 days |
| 3 | Adult → extension, and onto the engine | 3 days |
| 4 | Delete Jellyfin playback | 1.5 days |
| 5 | Jellyfin → extension, shipped disabled | 1.5 days |
| 6 | OIDC provider: generalise and switch off | 1 day |
| 7 | Docs, the 4.0.0 release, and switching the server off | 1 day |

Phases 0–1 can ship this week. Phase 2 must land before 3 and 5. Phases 3
and 4 are independent of each other. Phase 5 needs 4, because the sync must
stop feeding `isFilePlayable` before its columns go.

**When the Jellyfin server can be switched off.** Once phases 3 and 4 are
deployed, nothing MediaVault shows or plays depends on it:
- phase 3 removes the scene page's deep link;
- phase 4 removes the playback proxy.

The nightly relink and the Adult policy sync keep calling it until phase 5,
so unset `JELLYFIN_URL` in production at that point. Both then skip quietly,
as they do today on an unconfigured server. The server can then be stopped
whenever suits; the infrastructure clean-up is in phase 7.

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

- `/admin` shows a note on the Jellyfin row whenever `JELLYFIN_URL` is
  set: "Jellyfin support is deprecated. The server is being retired, and
  4.0.0 removes playback through it and moves library sync into an
  extension that is off by default".
- Log one warning at boot for each of `JELLYFIN_URL`,
  `JELLYFIN_MAX_SESSIONS` and `PLAYBACK_ENGINE=jellyfin`.
- README: mark the "Jellyfin" section deprecated. The "What it does"
  entries on playback and SSO describe the engine.

### 2. Build the extension seam

Pure refactor. Core behaviour and URLs don't change, and adult and Jellyfin
stay where they are.

- `src/extensions/{types,registry,events,settings}.ts`, with an empty
  registry.
- The Prisma schema becomes a folder (`prisma/schema/core.prisma`). Check
  that `prisma migrate diff` against the current database shows only the
  one new table.
- The one migration adds `ExtensionSetting`.
- An "Extensions" section on `/admin` lists every available extension:
  - its state (on, off or misconfigured, with the missing variables named);
  - a switch, for the owner only;
  - the audit rows for each change.

  It is empty until phase 3.
- `isExtensionEnabled(id)` has the per-request cache and invalidation
  described under "Enabling".
- The engine gains `stopSessionsOfKind(kind)`, which the off switch
  calls.
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
- **Delete the "Play in Jellyfin" link** on the scene page
  (`adult/[id]/page.tsx:21-38, 98-108`) and its `jellyfinPlayUrl` import.
  It has no replacement (decision 2).
- **Switch state on upgrade.** The same migration writes
  `ExtensionSetting('adult', enabled = 1)` **only if** any `Scene` rows or
  `adultLibraryAccess = 1` users exist, so the existing library stays
  visible after the deploy. A fresh install starts with Adult off.
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
- **Migration:** create the two tables **empty**, then drop the four
  columns from `Version`, `EpisodeFile`, `Scene` and `User`.
  - Nothing is copied: with the server retired, the item and user ids
    point at nothing. If Jellyfin ever returns, a relink rebuilds every
    link from scratch, and users are re-resolved by email, as
    `linkJellyfinUserId` does today.
  - SQLite rebuilds each table, so check the migration against a copy of
    the production database, as the two earlier `user` rebuilds were.
- **Code:** move `src/lib/jellyfin.ts` into
  `src/extensions/jellyfin/server/`:
  - The sync writes link rows instead of columns. Its safety guard
    (`shouldClearStaleIds`) and the NFC path normalisation come across
    unchanged, with their tests.
  - The adult pass runs only when the adult extension is enabled.
  - It is contributed as a `jobs` entry: after a scan of the kinds it
    links, and as a scheduler step.
  - Its run kind is `jellyfin:SYNC`, and old `JELLYFIN` rows alias to it.
- **UI:** the relink card and the integration row are contributed to
  `/admin`, and appear only when the extension is available.
- **Adult policy sync:** subscribes to `adult.accessChanged`.
  `resolveJellyfinUserId` and `linkJellyfinUserId` write
  `JellyfinUserLink`.
- `/api/jellyfin-sync` becomes a shim at the same URL, because the README's
  `curl` recipe uses it, and returns 404 when the extension is disabled.
- **Shipped disabled everywhere.** Production removes `JELLYFIN_*` from its
  env and does not list `jellyfin` in `MEDIAVAULT_EXTENSIONS`, so it
  doesn't even appear on `/admin`. CI still builds and tests it.

### 6. OIDC provider: generalise and switch off

- `registerJellyfinClient` becomes `registerTrustedOAuthClient`, and
  `JellyfinClientForm` becomes `TrustedClientForm`, with a **Remove**
  action that deletes the client and revokes its tokens. The audit event
  `jellyfin-client.register` gets a new name, and old rows still render.
- `OIDC_PROVIDER=on|off`, **default off**. When it is off:
  - the BetterAuth `oauthProvider` plugin isn't mounted;
  - `/consent` and the `.well-known` OIDC endpoints return 404;
  - `/signin` ignores `oauthQuery`;
  - the Trusted OAuth clients section on `/admin` is hidden.
- On deploy, the owner removes the Jellyfin client from `/admin` before the
  switch goes off. The `Jwks`, `Oauth*` tables and their rows are left to
  BetterAuth; nothing is dropped.
- Fix the stale `scripts/register-jellyfin-client.ts` references in
  `auth.ts` and `consent/page.tsx`.
- [PASSKEYS_PLAN.md](PASSKEYS_PLAN.md) phase 5 (SSO via passkey) is
  shelved, since it has no client to test against. Test B4 in
  [TEST_PLAN_2026-09.md](docs/TEST_PLAN_2026-09.md) is marked "only with
  `OIDC_PROVIDER=on`".
- The passkey-nudge and OTP code paths that skip themselves when
  `oauthQuery` is set stay as they are. They are inert with the provider
  off, and they are correct if it comes back.

### 7. Docs, release 4.0.0 and switching the server off

- Drop `user.adultLibraryAccess` (see phase 3).
- **README:**
  - The stack line loses "Jellyfin".
  - "Playback" describes the engine.
  - A new "Extensions" section lists `adult` and `jellyfin`, what each
    needs and how to enable it.
- **DEPLOYMENT.md:** remove the `JELLYFIN_URL` lines, the SSO section, the
  `jellyfin.markrwatts.com` Caddy site and its ACME DNS record, and the
  firewall rule for TCP 8096. Point to the Jellyfin extension's README for
  what they were.
- **`ansible-homelab`** (its own change, deployed with or after 4.0.0):
  - drop the Caddy site and the `_acme-challenge.jellyfin` DNS record;
  - drop the 192.168.6.53 → 192.168.1.11:8096 firewall rule;
  - retire `roles/jellyfin` and the `jellyfin-vm`.

  Keep a Proxmox backup of the VM until 4.0.0 has soaked for a week.
- Mark as historical: PLAN.md, PLAYBACK_PLAN.md "Status", and
  IOS_PLAN.md's video section. V4_PLAN.md phase 6 points here.
- Each extension's `README.md` covers its env, tables, routes, events and
  how to delete it.
- Set `package.json` to 4.0.0.

## Reinstating Jellyfin later

| Want | Do |
|---|---|
| Library sync, adult policy sync, nightly relink | Add `jellyfin` to `MEDIAVAULT_EXTENSIONS`, set `JELLYFIN_URL` and `JELLYFIN_API_KEY`, switch it on under Extensions on `/admin`, and press Relink. The link tables fill from scratch. |
| Sign in to Jellyfin with MediaVault accounts | `OIDC_PROVIDER=on`, register the plugin's redirect URI under Trusted OAuth clients, restore the Caddy site for the HTTPS name. |
| A "Play in Jellyfin" button | Deleted by decision 2. It would come back as a slot the Adult (or film) page exposes and the Jellyfin extension fills, so neither page imports Jellyfin. |
| Watch-state sync with Jellyfin | A new job in the Jellyfin extension, plus an `on.playbackProgress` event core would emit from `play-events.ts`. It fits the seam and needs no core change beyond the event. |
| Jellyfin as the playback backend again | Not supported by the seam on purpose. It would need a `playbackBackend` hook in `playback/routes.ts`; start from the `jellyfin-final` tag. |

## Testing

- Every phase keeps `npm run lint`, `typecheck` and `test` green, and runs
  `scripts/e2e-engine.ts` against a real ffmpeg.
- **Phase 2:**
  - Snapshot tests show that `navItemsFor`, the runs summary, the
    stream-key regex and `/api/v1/me` are byte-identical before and after
    the refactor.
  - Only the owner can flip a switch: the action refuses a member, and the
    audit row is written.
  - The cache is invalidated on toggle.
- **Phase 3:**
  - An adult on/off matrix: nav, `/adult` (200 or 404), the image route,
    session, `/api/v1/me`, and the scanner tick.
  - An age-restricted member with an `AdultAccess` row is refused
    everywhere.
  - Engine playback of a scene: seek, the Remote variant, and stop.
  - Switching Adult off during playback stops the session and 404s the
    next segment.
  - Switching Adult on doesn't grant any member access.
  - The upgrade migration switches Adult on for a database with scenes and
    leaves it off for an empty one.
- **Phase 5:**
  - The migration runs cleanly against a copy of the production database,
    and every other column survives the table rebuilds.
  - The existing `jellyfin.test.ts` cases, including the blocked-sweep
    guard, pass against link tables and a stubbed server.
- **Phase 6:**
  - With `OIDC_PROVIDER` off, `/consent` and discovery return 404, and a
    `/signin?…oauth_query` link behaves as a plain sign-in.
  - With it on, a test client completes the flow. This is the check that
    the path still works for a reinstated Jellyfin.

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
- **A runtime switch read at module load.** Anything that caches "is Adult
  on" beyond one request survives a toggle, and reads as a leak: Adult
  still showing after the owner switched it off. The rule is that every
  read goes through `isExtensionEnabled`, and the toggle test above flips
  it within one process to catch violations.
- **Switching the server off too early.** Wait until phases 3 and 4 are
  deployed, and unset `JELLYFIN_URL` first. Before then, the scene page's
  deep link and `PLAYBACK_ENGINE=jellyfin` (the escape hatch) still point at
  it.

## Open questions

None outstanding. The three from the first draft were answered on 26 Sep
(see Status).

## Later

- Retire the `/jf/*` aliases, the `"jellyfin"` `PlaybackSource` value and
  `features.jellyfin` with a `minAppBuild` bump, once every native build in
  the house speaks `play/*`.
- Candidates for the seam once it exists: Concerts (already half-separate
  via `Film.kind`), and the barcode Scan companion API.
