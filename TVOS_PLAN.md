# MediaVault — Apple TV App Plan

An Apple TV 4K app that plays the same library the web and iOS apps do:
films and episodes with resume and continue-watching, and the music
library with its albums, favourites and playlists. It signs in by scanning a
QR code with a phone rather than typing on the Siri Remote.

It replaces the MediaVaultTV prototype (separate repo), which cannot work
against today's server: it reads `/api/films` with no session, and that
route has been member-gated since households landed, so production answers
401. Its player drives the old `status → prepare → stream` routes, which
only exist behind `IN_APP_PLAYBACK=1`. About 280 lines, films only. Nothing
in it is carried forward except the README's findings (no WebKit on tvOS;
use a real `.xcodeproj`, not a bare package).

## What version 1 can assume

- **Video is mp4, H.264, with an AAC default track.** The library is being
  converted to that shape (other tracks — DTS, TrueHD, Atmos — may sit
  alongside as optional extras). The engine's `original` variant should
  copy these straight into HLS with no re-encode; the first play checks it
  (`transcodeReasons` comes back empty).
- **Music is Apple Lossless or MP3.** `AVQueuePlayer` plays both from
  `/api/audio/:id/file` as it does on iOS; the TV always asks for the
  original (it is never on cellular).
- **The server's own engine plays video** (`PLAYBACK_ENGINE=local`,
  V4_PLAN.md), not Jellyfin, for most content. The TV doesn't care which:
  it speaks the engine-agnostic session contract (below), and reads
  `me.features.playback` rather than the legacy `jellyfin` flag.

## Where the app lives

A second target, `MediaVaultTV`, in the **MediaVaultiOS** repo's
`project.yml`, bundle id `com.markrwatts.mediavault.tv`, same team. The
MediaVaultTV repo is archived with a README pointing there.

- `MediaVaultKit` already compiles for tvOS unchanged (checked with
  `xcodebuild` against the tvOS Simulator SDK). Both targets depend on it.
- The app-layer code that isn't UI and isn't iOS-only — `LibraryStore`,
  `ConnectionMonitor`, `Favourites`, `ArtworkCache`, `AudioPlayer`,
  `NowPlayingCenter`, `RemoteCommands`, `AudioSessionCoordinator`,
  `VideoSession` — moves to a `Shared/` folder compiled into both targets,
  with `#if os(tvOS)` for the few differences. It stays out of the Kit,
  which keeps its no-AVFoundation rule.
- iOS-only stays put: CarPlay, `OrientationLock`, `TrackCache` (offline
  tracks), the phone's screens.

A separate repo would need `MediaVaultKit` split into its own repo
(SwiftPM wants `Package.swift` at a dependency's root) for no gain.

## tvOS constraints that shape it

- **No persistent local storage.** Only the Caches directory is writable,
  and the system purges it. `LibraryCache`, `ArtworkCache` and the saved
  queue move there on tvOS and are treated as best-effort: a purged cache
  is a cold launch, not an error. The offline track cache is dropped.
- **Focus, not touch.** No swipe actions, no drag-to-reorder; every screen
  is built for the focus engine (`.buttonStyle(.card)`, focus sections).
- **Typing is miserable** — hence QR sign-in.
- **Screen scale.** `CoverSize.fitting(points:)` assumes a phone's @3x.
  tvOS draws at @1x (HD) or @2x (4K); the scale becomes a parameter.
- **Identity.** `APIClient` and `SignInFlow` hard-code
  `User-Agent: MediaVault iOS/<version>`. The platform becomes a parameter
  so the audit log and `Session.userAgent` show `MediaVault tvOS/<version>`.

## Sign-in: scan a QR code with your phone

BetterAuth 1.7.2 ships the `deviceAuthorization` plugin (RFC 8628 device
flow). The web and iOS keep email OTP and passkeys; the TV borrows
whichever the phone already has.

### The flow

1. The TV calls `POST /api/auth/device/code` with `client_id:
   "mediavault-tvos"` and shows a QR code of `verification_uri_complete`
   (`https://<host>/device?user_code=ABCD-EFGH`) with the code in large
   type beside it.
2. The phone's camera opens that URL:
   - **iOS app installed** — the Universal Link opens the app, which shows
     "Sign in Apple TV? Code ABCD-EFGH" and approves with the session it
     already holds. One tap.
   - **Otherwise** — Safari opens `/device`. Signed out, the proxy's
     existing redirect sends it to `/signin?callbackURL=/device?...`
     (email code or passkey) and back. The page shows the same prompt.
3. Approve calls `GET /api/auth/device?user_code=` (claims the code for
   the signed-in user) then `POST /api/auth/device/approve`. Deny calls
   `/device/deny`.
4. The TV polls `POST /api/auth/device/token` at the server's `interval`,
   handling `authorization_pending`, `slow_down` (back off), `expired_token`
   (fetch a new code, redraw the QR) and `access_denied`. On success it
   stores the token in the Keychain, exactly as the OTP path does.

"Sign in with email instead" stays on the TV as the fallback, driving the
existing `SignInFlow` (the iPhone keyboard prompt helps here).

### Server work

- **Sign the device token (the one real gap).** `/device/token` returns
  the raw `session.token` in its JSON body and sets no cookie, so the
  `bearer` plugin's after-hook never adds `set-auth-token`, and the value
  isn't signed. With `bearer({ requireSignature: true })` the proxy's
  `verifySessionCookie` rejects an unsigned token. Fix: an `after` hook on
  `/device/token` in `auth.ts` that sets the signed session cookie for the
  new session, so the bearer hook emits `set-auth-token` with the signed
  `<token>.<hmac>` and the TV reads that header — the same contract as
  `/sign-in/email-otp`. The body's `access_token` is ignored.
- **Plugin config.** `deviceAuthorization({ verificationUri: "/device",
  expiresIn: "10m", validateClient: id => id === "mediavault-tvos" })`.
- **Schema.** The plugin's device-code table as a Prisma model and
  migration.
- **The web of trust still applies.** The token endpoint creates the
  session through `internalAdapter.createSession`, which runs
  `databaseHooks.session.create.before`. A test pins that a non-member's
  approval produces no session.
- **`/device` page.** Member-gated (not in `PUBLIC_PATHS`), in the
  chromeless card style of `/consent`: the code to compare, what is asking
  (named from its client id — the plugin's row records no user agent),
  Approve / Deny, and the outcome. Invalid, expired and already-used codes
  get plain messages; with no code in the URL it asks for one.
- **No pre-bound codes.** The plugin lets `/device/code` bind a code to a
  `user_id` up front; a `hooks.before` refuses that, since nothing of ours
  needs it and it only helps target one person with an approval request.
- **Audit.** `device.approve` / `device.deny` rows, written from the same
  `hooks.after`, so approvals from the iOS app are recorded as well as the
  web page's.
- **AASA.** `app/.well-known/apple-app-site-association/route.ts`
  (JSON, no extension), public in `src/proxy.ts`, listing
  `2Y2TMF4L4P.com.markrwatts.mediavault` under `applinks` for `/device`
  and under `webcredentials` (which PASSKEYS_PLAN.md's native passkeys need
  anyway). DEPLOYMENT.md notes it must be reachable over the Tunnel with no
  session and not cached with a redirect.

### iOS app work

- `com.apple.developer.associated-domains` with
  `applinks:<host>` (and `webcredentials:<host>`) in `project.yml`.
- `onOpenURL` for `/device?user_code=` → an approval sheet (code, Approve,
  Deny) calling the two endpoints with the bearer. Signed out, it shows
  sign-in first and then the sheet.
- **Account → "Sign in a TV"**: an in-app scanner
  (`DataScannerViewController`) for when the camera's Universal Link
  handoff isn't used, plus manual code entry.

### Risks

- **Tricked approval** (a QR code for someone else's device). Mitigated by
  showing the code on both screens with "check it matches your TV", a
  10-minute code life, member-only approval, the single allowed client id,
  and the audit row. Worth a line in the prompt: "Only approve a TV you
  are in front of."
- **Rate limiting.** Polling hits `/api/auth/*`. BetterAuth's own limiter
  is fine with a 5 s interval, but DEPLOYMENT.md's planned Cloudflare rule
  (10 a minute on `/api/auth/*`) is not: `/api/auth/device/token` has to
  be left out of it.

## One Apple TV, several people

Apple TV profiles are how a household shares one TV, and each person's
MediaVault account carries their own progress, Continue Watching,
favourites and playlists. The TV app keeps them apart by letting tvOS do
it:

- **User Management → Runs as Current User**
  (`com.apple.developer.user-management` = `runs-as-current-user`, tvOS
  16+). tvOS gives each Apple TV profile its own copy of the app's data,
  Keychain included. Each person scans the QR code once on their own
  profile; switching profiles in Control Center brings MediaVault up as
  that person, and a profile that has never signed in sees the QR screen.
- **Not** `runs-as-current-user-with-user-independent-keychain` /
  `kSecUseUserIndependentKeychain`: that shares one sign-in across
  profiles, the opposite of the point.
- **No in-app account switcher.** An app that keeps several accounts in
  one shared container and switches between them itself (YouTube's is the
  familiar example) is how people end up watching on each other's
  accounts. The Apple TV profile *is* the MediaVault profile.
- **The one way to cross accounts** is approving the QR code while the TV
  is on the other person's profile. A "Signed in as …" confirmation after
  every fresh sign-in makes that obvious at once; Settings → Sign out
  fixes it.
- Nothing server-side: each profile holds its own session, and everything
  per-user on the server is already keyed on it.
- To verify on a real Apple TV with two profiles (needs the paid team for
  a device build): each profile signs in separately; switching profiles
  relaunches the app as the other person; music playing on one profile
  stops on a switch.

## Playback contract

Unchanged from iOS (IOS_PLAN.md "Video"), served by `engine-routes.ts`
under the local engine:

- `POST /api/video/:versionId/jf/session?variant=original` (episodes:
  `/api/tv-video/:episodeFileId/…`) → `playlistUrl`, `playSessionId`,
  `durationSecs`, `transcodeReasons`, `audioTracks`.
- Play `playlistUrl` (`…/jf/e/<key>/master.m3u8?ps=<id>`) with the session
  cookie on `AVURLAsset` (`AVURLAssetHTTPCookiesKey`); segments carry
  `?ps=` too.
- `GET/POST …/progress` for resume and history; `POST …/jf/stop` on close.
- V4_PLAN.md phase 6 renames `/jf/*` to `play/*` with aliases. The paths
  stay inside `APIClient` only, so that rename touches one file.

The TV reuses `VideoSession` as it is — startup retry, mid-film
re-session, 15 s progress — and presents `AVPlayerViewController`, which
gives Siri Remote scrubbing, the info panel and `externalMetadata`
(title, description, artwork) for free.

## Screens

Top tab bar: **Home, Movies, Shows, Music, Search, Settings**. Movies and
Shows hide when `features.tv` is false, Music when `features.music` is.

- **Home** — rows of focusable cards: Continue Watching (films and
  episodes), Recently Added, Recent Albums.
- **Movies** — poster grid under the same shelves as iOS (Continue
  Watching, Favourites), plus Collections. **Film detail**: backdrop,
  overview, badges, heart, Resume / Play from Start, version picker.
- **Shows** — grid. **Show detail**: season picker, episodes with stills,
  resume.
- **Music** — artist and album index, artist and album pages,
  Play / Shuffle, favourites. Playlists: browse, play, and "Add to
  Playlist" from a track's context menu; rename, delete and reorder stay
  on the phone and web. **Now Playing**: cover, transport, queue.
  Background audio (`UIBackgroundModes: audio`), the system Now Playing
  card and remote commands come through the shared player.
- **Search** — `.searchable` (the system search keyboard) over the loaded
  index, as on iOS.
- **Settings** — account, server URL, sign out, about.

### Not in version 1

Audio-track choice (default AAC only), subtitles, playlist editing beyond
"add", a Top Shelf extension, "Up Next" episode proposals
(`AVContentProposal`), passkeys on the TV itself.

## Phases

| # | What | Est. (days) |
|---|---|---|
| 0 | **Scaffold.** TV target in `project.yml`; Kit takes a platform for the User-Agent and decodes `features.playback`; `CoverSize` takes a screen scale. Launches to a placeholder in the Apple TV simulator; iOS builds and `swift test` still pass. | 0.5 |
| 1 | **Shared code.** Move the portable app layer into `Shared/`, tvOS storage to Caches, `#if os(tvOS)` for the differences. Both targets build. | 1 |
| 2a | **Server: device sign-in.** Plugin, token-signing hook, migration, `/device` page, audit rows, AASA route, tests. | 1.5 |
| 2b | **TV: sign-in and shell.** QR sign-in with polling, email fallback, tab bar, Settings, connection banner. | 1 |
| 2c | **iOS: approve a TV.** Associated domains, `/device` Universal Link sheet, "Sign in a TV" scanner. | 1 |
| 3 | **Video.** Movies and Shows browse and detail, `AVPlayerViewController` over `VideoSession`, resume and progress. Exit: a converted mp4 plays with no transcode reasons, stops, and resumes where it left off. | 2–3 |
| 4 | **Music.** Browse, the shared `AudioPlayer`, Now Playing, background audio. Exit: a gapless ALAC album and an MP3 album play through, continuing after leaving the app. | 2 |
| 5 | **Polish.** Home rows, Search, focus behaviour, error surfaces (401 → sign-in, the server's refusal messages shown verbatim). | 1–2 |
| 6 | **Ship.** TestFlight, archive MediaVaultTV, delete `/api/films`, `/api/films/[id]` and the legacy `/api/video/*/{status,prepare,stream}` routes once nothing calls them. | 0.5 |

Simulator verification needs no Siri Remote: the iOS app's `DebugLaunch`
switches (initial tab, open a video directly, play N seconds) come across
to the TV target so each screen can be launched and screenshotted with
`simctl`.

## Things that could go wrong

- **The engine re-encodes a converted file.** Caught at phase 3's exit
  check via `transcodeReasons`; the fix is on the server's
  `decisions.ts`, not the app.
- **Toolchain skew.** Xcode 27's tvOS SDK with a tvOS 26.5 simulator: the
  deployment target stays at or below 26.5.
- **Cache purges.** A cold launch after a purge must look like a first
  launch with a spinner, not an error.
- **Surround passthrough (after v1).** `AVPlayer` passes E-AC-3 (and
  Atmos over DD+) but not TrueHD or DTS; an audio picker must list only
  what the server says it can serve.

## Docs to update

- `README.md`: this file in the documentation table (done with this plan).
- `PLAN.md`: "Native-client API" — tvOS is on `/api/v1` and bearer via
  device authorization.
- `IOS_PLAN.md`: "Explicitly deferred" — moving MediaVaultTV onto the Kit
  is now this plan.
- `DEPLOYMENT.md`: the AASA route (phase 2a).
