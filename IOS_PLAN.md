# MediaVault — iOS Companion App Plan

An iPhone/iPad app that plays the same library the web app does — the
gapless music player with its queue, playlists and favourites, and films
and episodes through Jellyfin with resume — but the way Spotify and YouTube
do it: playback carries on when the app leaves the foreground, the lock
screen and Control Centre show what's playing with working transport
controls, headphone buttons and CarPlay/AirPlay routes work, and a phone
call pauses and resumes it.

Why the web app can't be made to do this: on iOS, Safari and every
WKWebView suspend the Web Audio `AudioContext` the moment the page leaves
the foreground, and `player-engine.ts` *is* a Web Audio scheduler
(PLAYLISTS_PLAN.md). A home-screen PWA or a WebView shell would have the
same ceiling. The Media Session hooks `PlayerProvider.tsx` already sets
give a lock-screen card, but the audio behind it stops. Background audio
on iOS is only available to a native `AVFoundation` player running under
the `audio` background mode — so this is a native app, not a wrapper.

The MediaVaultTV shell (separate repo) is the precedent for a native
client: it reads `/api/films` and hands HLS URLs to `AVPlayerViewController`.
It has no sign-in of its own (PLAN.md "Native-client API"). This plan gives
the native side a real auth flow and a real API, which tvOS can then adopt.

## Goals and non-goals

**In scope**

- Music: browse artists/albums/favourites/playlists, play an album,
  playlist or the favourites list, queue editing (play next, add, remove,
  reorder), shuffle, repeat — feature parity with the rail
  (`components/shell/*`, `src/lib/player-engine.ts`).
- Background audio, lock screen / Control Centre / Now Playing card,
  remote commands (headphones, Apple Watch, CarPlay's Now Playing screen),
  AirPlay, interruption and route-change handling.
- Films and episodes: the same Jellyfin-brokered HLS the web player uses,
  with Original/Remote quality, audio-track choice, resume, progress
  reporting, continue-watching rows, Picture in Picture, and audio that
  keeps going when the phone is locked mid-film.
- Sign-in with the same email one-time code as the web (and later the
  same passkeys), gated by the same web of trust.
- Works over the LAN and over the internet (the Cloudflare Tunnel URL),
  with the same per-network quality default as the web.

**Out of scope**

- Everything owner-only (scan, enrich, report, admin, barcode scanning) and
  the collector's data entry (physical copies, Discogs fix-ups). The web
  app remains the place for that.
- The Adult media type. App Store Review Guideline 1.1.4 rules it out of
  any build that goes through TestFlight/App Store, and it is an opt-in
  side library anyway. The app never lists it and never calls its routes.
- Offline downloads, CarPlay's full browse UI, widgets — see "Later".

## Shape of the app

- **A new repo, `MediaVaultiOS`**, SwiftUI, iOS 17+, one Xcode project
  with a Swift package `MediaVaultKit` (API client, DTOs, token store,
  playback-queue model) that MediaVaultTV can depend on later, and an
  app target that owns the UI and the players. Same posture as
  MediaVaultTV: the server is this repo, the client is its own project.
- **No WebView anywhere.** The tvOS shell wraps the web app because it
  had to ship fast; the iOS app's whole reason to exist is the native
  player, and half-native apps get the worst of both (two sign-ins, two
  navigation stacks, one of which can't play in the background).
- **Tabs mirror `nav-items.ts`**: Movies, Shows, Music, Account, with a
  mini player above the tab bar and a full-screen Now Playing sheet —
  the same layout `mobile-player-bar.tsx` already gives a phone, so the
  app looks like the site rather than a different product.
- **One base URL**: `https://mediavault.markrwatts.com` (the Tunnel).
  Cloudflare fronts it on the LAN too, so the app never has to switch
  hosts. The server tells the app which network it arrived on (see
  `/api/v1/me`) for the quality default, exactly as `request-network.ts`
  does for the web.

## Server work (this repo)

Everything below is additive; the web app is unchanged.

### 1. Bearer sessions for native clients

The web signs in with email OTP and carries a signed session cookie.
BetterAuth's `bearer()` plugin makes the identical session usable from
a native app: the OTP sign-in response gains a `set-auth-token` header
holding the session token, and later requests present it as
`Authorization: Bearer <token>`. `auth.api.getSession({ headers })` — what
`requireMemberOrResponse`, `currentViewer` and the progress routes all
call — then resolves it with no other change. Everything the web of trust
enforces (the `session.create.before` hook, the OTP throttle, allowed
emails, invitations, access codes) applies unchanged because it is the
same sign-in path; a stranger can no more get a bearer token than a
cookie.

- Add `bearer({ requireSignature: true })` to `plugins` in `src/lib/auth.ts`
  (before `nextCookies()`, which must stay last). With `requireSignature`
  the token in the header is the *signed* cookie value —
  `<token>.<base64 HMAC>` — the exact shape `src/lib/session-cookie.ts`
  already verifies.
- `src/proxy.ts`: alongside the cookie, accept
  `Authorization: Bearer …` and run it through the same
  `verifySessionCookie`. That keeps the proxy's cheap, DB-free posture (a
  forged header is as useless as a forged cookie) and means every
  existing gated route — `/api/cover`, `/api/poster`, `/api/audio`,
  `/api/video/*`, `/api/tv-video/*` — works for the app with no
  per-route edits. `route-guards.test.ts` and `session-cookie.test.ts`
  gain the bearer cases.
- Sign-in flow the app drives (all existing BetterAuth JSON endpoints under
  `/api/auth/`, already public in the proxy):
  1. `POST /email-otp/send-verification-otp` `{ email, type: "sign-in" }`
  2. `POST /sign-in/email-otp` `{ email, otp }` → `set-auth-token` header
  3. `GET /get-session` with the bearer to validate on launch
  4. `POST /sign-out` on sign-out (revokes the session server-side; the
     web's "sign out everywhere" in `revoke-sessions.ts` covers the app's
     sessions too, since they are ordinary `Session` rows).
- The audit log already records sign-ins; add the user-agent family
  ("MediaVault iOS/1.2") so `/admin` can tell app sessions from browser
  ones. No schema change: `Session.userAgent` exists.

Not the device-authorization plugin (PLAN.md's suggestion for tvOS): that
flow exists for devices with no keyboard. A phone can type a six-digit
code, and the OTP path is the one the web of trust is built around. tvOS
can add device-authorization later on top of the same bearer plumbing.

### 2. A versioned native API: `/api/v1/*`

The web pages are Server Components and their mutations are server
actions, neither of which a native client can call. `/api/films` and
`/api/films/[id]` are the only JSON reads today. The app needs a small,
explicit surface, every route gated by `requireMemberOrResponse` (so
`route-guards.test.ts` enforces it) and each one a thin wrapper over a
query or action body that already exists:

| Route | Wraps | Notes |
|---|---|---|
| `GET /api/v1/me` | session + `Member` + `networkKind()` | `{ user, household, network: "lan"\|"remote", features: { tv, music, jellyfin }, server: { version, minAppBuild } }`. `minAppBuild` lets the server refuse a stale client with a clear message. |
| `GET /api/v1/films` | `getLibraryFilms`, `getContinueWatchingFilms`, `getFavouriteFilms` | Shelves + the grid, trimmed to card fields. Replaces `/api/films` for the app; the old route stays for tvOS until it moves. |
| `GET /api/v1/films/:id` | `getFilmDetail` + `film-user-state` | Versions with their `jellyfinId` presence as `playable`, audio tracks, saved progress. |
| `PUT/DELETE /api/v1/films/:id/favourite` | `film-state.ts` toggle | |
| `GET /api/v1/shows`, `GET /api/v1/shows/:id` | `getShows`, `getShowDetail`, `getContinueWatchingEpisodes` | Episode files carry `playable` + progress. |
| `PUT/DELETE /api/v1/shows/:id/favourite` | show favourite action | |
| `GET /api/v1/music` | `getMusicIndex`, `getMusicFavourites`, `countFavouriteTracks`, `getUserPlaylists` | The index page's data in one call; the library is a few thousand rows, no paging needed. `ETag` from the newest `updatedAt` so a relaunch is a 304. |
| `GET /api/v1/music/artists/:id` | `getArtistDetail` + `getArtistUserState` | |
| `GET /api/v1/music/albums/:id` | `getAlbumDetail` + `getAlbumUserState` | Tracks as `QueueTrack` (`player-types.ts`) plus `playable` from `isPlayableCodec`. Physical-only albums come back with no tracks, same as the page. |
| `GET /api/v1/music/favourites` | `getFavouriteTracks` | As `QueueTrack[]` |
| `GET/POST /api/v1/music/playlists`, `GET/PATCH/DELETE …/:id` | `music-state.ts` create/rename/delete + `getPlaylistDetail` | |
| `POST …/:id/items`, `PUT …/:id/items` (full order), `DELETE …/:id/items/:itemId` | add/remove/reorder actions | Reorder sends the complete id order, like the drag UI. |
| `PUT/DELETE /api/v1/music/favourites/{tracks,albums,artists}/:id` | the three toggles | Album/artist favouriting still creates/removes the linked playlist. |

To share code rather than copy it, the bodies of `app/actions/music-state.ts`
and `film-state.ts` move into `src/lib/music-user-state.ts` /
`film-user-state.ts` (both files exist and already hold the read side),
taking `userId` as a parameter; the server actions become
`requireMember()` + call + `revalidatePath`, and the routes become
`requireMemberOrResponse()` + call + the same `revalidatePath` calls (a
heart tapped in the app must show on the web's next render, and the rail's
"Favourite tracks · N" is rendered in the root layout).

DTOs: hand-written TypeScript interfaces in `src/lib/api-v1-types.ts`,
mirrored as `Codable` structs in `MediaVaultKit`. No codegen — the surface
is small and the existing `QueueTrack`/`FilmDetail`/`ShowDetail` shapes are
already stable.

Images: `/api/cover/:albumId`, `/api/poster/…`, `/api/artist-image/…` are
reused as-is (bearer accepted by the proxy). The `coverVersion`
cache-buster stays the client's cache key.

### 3. Audio: the original file, with ranges

`/api/audio/:trackId` serves raw PCM at the client's sample rate because
that is the only thing a browser can play progressively and gaplessly.
`AVFoundation` does not need that help: it decodes AAC, ALAC, MP3 and FLAC
natively (FLAC since iOS 11) and plays a progressive HTTP source from the
first bytes provided the server honours byte ranges. So:

- `GET /api/audio/:trackId/file` — the track's own bytes via
  `serveFile()` (`src/lib/serve-file.ts`, already range-aware, already
  used by `/stream`), `Content-Type` from the codec (`audio/mp4` for
  ALAC/AAC, `audio/mpeg`, `audio/flac`), `Cache-Control: private,
  max-age=31536000, immutable` keyed by the app on `mtimeMs`. Refuses DRM
  and unprobed tracks exactly as `resolvePcmFormat` does (404).
- No ffmpeg, so the `audioSemaphore` is not involved: the app's playback
  costs the server a file read, which matters on the 4-core VM while a
  film is transcoding.
- The PCM route stays for the web. Nothing changes there.

Bandwidth: ALAC is ~700–1000 kbit/s, AAC ~256 kbit/s — both below the
1.4 Mbit/s the web's PCM stream costs, so cellular listening is cheaper
than the site.

### 4. Video: nothing new, one contract to honour

The Jellyfin path is already a plain JSON + HLS API and already what
AVPlayer wants (PLAYBACK_PLAN.md "Status"): `POST /api/video/:versionId/jf/session?variant=&audio=` returns
`playlistUrl`, `playSessionId`, `durationSecs`, `audioTracks`; the app
plays `playlistUrl` (with the bearer on every playlist/segment request,
via `AVURLAsset`'s `AVURLAssetHTTPHeaderFieldsKey`); `POST …/jf/stop` on
close; `GET/POST …/progress` for resume and history. Episodes are the
`/api/tv-video/:episodeFileId/…` twins. The concurrent-stream cap and
"is Jellyfin configured" 503s come back as JSON `error` strings the app
shows verbatim, as the web does.

One thing to add: the `/status` route's `state: "direct"` tier is only
reachable with `IN_APP_PLAYBACK=1` (the parked local pipeline), so the
app targets the Jellyfin routes only and `/api/v1/films/:id` reports a
version as `playable` iff it has a `jellyfinId`. Same for episode files.

### 5. Passkeys (phase 4) and Universal Links

`@better-auth/passkey`'s endpoints are JSON and can be driven by
`ASAuthorizationPlatformPublicKeyCredentialProvider` for a username-less
sign-in with Face ID, using the passkeys members already registered on
the web (same rpID: the hostname of `BETTER_AUTH_URL`). It needs:

- `/.well-known/apple-app-site-association` served by the app
  (`app/.well-known/apple-app-site-association/route.ts`, JSON, no
  extension) listing the app's Team ID + bundle id under `webcredentials`
  (and `applinks` if Universal Links are wanted for shared album URLs).
- That path made public in `src/proxy.ts` (`PUBLIC_PATH_PREFIXES`).
- Nothing in the WebAuthn config changes: `origin` is already pinned to
  `BETTER_AUTH_URL`, and Apple's native passkey ceremony presents the same
  origin.

### 6. Later, server-side

- **Music listening history** (PLAN.md "Worth doing next"): the app would
  report track plays the way the web can't (backgrounded), so once the
  server has a route it is a one-line addition in the player. Not part of
  this plan.
- **tvOS onto `/api/v1` + bearer via the device-authorization plugin**:
  the reason the surface is versioned.

## The iOS app

### Modules

```
MediaVaultiOS/
  MediaVaultKit/            Swift package, no UIKit
    API/        APIClient (URLSession, bearer, 401 → signed-out, ETag cache)
                DTOs (Codable mirrors of api-v1-types.ts)
    Auth/       TokenStore (Keychain, kSecAttrAccessibleAfterFirstUnlock)
                SignInFlow (send code → verify → token)
    Queue/      QueueModel — a port of player-engine.ts's queue semantics
                (insertion order, play order, shuffle, repeat, play-next,
                add, remove, move, context) with the audio parts left out,
                unit-tested the way player-engine.test.ts is
  App/
    Player/     AudioPlayer (AVQueuePlayer), NowPlayingCenter, RemoteCommands,
                AudioSessionCoordinator, VideoSession (Jellyfin lifecycle)
    UI/         SwiftUI: tabs, browse screens, mini player, Now Playing
                sheet, queue, playlists, video screen, sign-in, account
```

`MediaVaultKit` is the piece MediaVaultTV adopts later; it must compile
for tvOS from day one (no `UIApplication`, no `AVAudioSession` in it).

### Music playback engine

**Decision: `AVQueuePlayer` over the original files, not a port of the
PCM engine.** The web engine schedules half-second PCM chunks on an
`AudioContext` because a browser has no other way to start instantly and
join tracks sample-accurately. `AVQueuePlayer` gets both from the
platform: it pre-rolls the next `AVPlayerItem` while the current one plays,
and joins ALAC and iTunes-encoded AAC gaplessly using the encoder-delay
metadata those files carry (this library is an iTunes layout ripped from
CD, so the bulk has it). It also gives, for free, everything the
background story needs: it keeps playing under the `audio` background
mode with the app suspended between buffer refills, routes to AirPlay and
CarPlay, survives a Wi-Fi to cellular hand-off by re-issuing range
requests, and reports `timeControlStatus` for the loading/stalled states
the mini player shows.

The alternative — `AVAudioEngine` + `AVAudioPlayerNode` fed from
`/api/audio/:id` PCM — is a direct port of `player-engine.ts` and is
sample-accurate for any source, but it means owning buffering, seeking,
stall recovery and reconnection ourselves, streaming 1.4 Mbit/s of PCM
over cellular, and keeping the process alive for the whole listen (an
`AVAudioEngine` app can't be suspended between refills the way an
`AVPlayer` app can). It stays the documented fallback if phase 2's
gapless check on a live album finds an audible join with MP3 sources
(which carry no priming info); it would slot in behind the same
`AudioPlayer` protocol.

Queue behaviour ports one-to-one from `player-engine.ts`: the app holds
the whole queue in `QueueModel` and keeps `AVQueuePlayer` loaded with only
the current item and its successor — the same "at most two alive"
invariant the web engine keeps for memory and bandwidth — rebuilding the
successor after every queue edit (`rechainAfterCurrent`'s job). Shuffle
reorders `order`, not `queue`, so un-shuffling restores insertion order;
repeat wraps the play order. `QueueTrack` is the wire shape in both
directions, so an album, a playlist and the favourites list enqueue
identically.

Playback state persists across launches (queue, position, context) in
the app container, so force-quitting and reopening resumes where the
web can't. Album art for the lock screen comes from `/api/cover/:id`
through the same authenticated client, cached on disk by `coverVersion`.

### Background audio: the checklist

This is the part the whole plan exists for; each line is a known
iOS failure mode when missed.

1. `UIBackgroundModes: audio` in `Info.plist`. Without it playback stops
   on lock within seconds.
2. `AVAudioSession` category `.playback` (mode `.default` for music,
   `.moviePlayback` for video), activated before the first play and left
   active while there is a current item; deactivated with
   `.notifyOthersOnDeactivation` only when the queue ends or the user
   stops, so Spotify or Podcasts resume when we finish.
3. `MPNowPlayingInfoCenter` fed title/artist/album/artwork/duration/
   elapsed/rate on every track change, seek, play and pause. Elapsed
   time is set with the rate and left to run — not updated on a timer —
   so the lock-screen scrubber doesn't stutter.
4. `MPRemoteCommandCenter`: play, pause, toggle, next, previous,
   changePlaybackPosition, skipForward/skipBackward (video only, 10 s),
   like/dislike (map to the track heart). Unused commands disabled so
   the lock screen shows only real buttons.
5. Interruptions (`AVAudioSession.interruptionNotification`): pause on
   begin; on end, resume only if `.shouldResume` is set (a phone call)
   — never after Siri or an alarm the user dismissed.
6. Route changes: `.oldDeviceUnavailable` (headphones unplugged, car
   Bluetooth dropped) pauses; a new route never auto-plays.
7. Network: `AVPlayer` handles Wi-Fi to cellular for progressive audio
   and HLS on its own; the app watches `NWPathMonitor` only to show
   "Remote quality recommended" for video, as the web does after stalls.
8. Launch in the background for remote commands: when the app has been
   killed and a headphone play button is pressed, iOS relaunches it if
   `MPRemoteCommandCenter` handlers are registered at launch and the
   persisted queue can be restored — so `AudioPlayer` and the queue
   restore are set up in `App.init`, not on first screen.
9. Video with the screen off: on `didEnterBackground`, detach the layer
   (`playerLayer.player = nil`) and reattach on `willEnterForeground` —
   Apple's documented way to let a video's audio continue in the
   background — unless Picture in Picture has taken over, in which case
   leave it alone.
10. Picture in Picture: `AVPlayerViewController` with
    `allowsPictureInPicturePlayback` and
    `canStartPictureInPictureAutomaticallyFromInline`, so swiping home
    mid-film floats it, exactly like YouTube.

### Video

`AVPlayerViewController` in a full-screen cover, reached from a film's
version row or an episode row, with the same chrome the web player has:
a quality menu (Original/Remote, remembered per network in
`UserDefaults`, defaulting from `/api/v1/me`'s `network`), an audio-track
menu built from the session's `audioTracks` (changing it starts a new
Jellyfin session at the current position, as `VideoPlayer.tsx` does), and
a resume prompt from the saved progress.

`VideoSession` owns the Jellyfin lifecycle: `jf/session` → play → periodic
`progress` POSTs (`WATCH_PROGRESS_REPORT_INTERVAL_SECS`, `isNewPlay` once
per session, the same `WATCH_COMPLETED_RATIO` on the server) → `jf/stop`
on dismiss or when the queue moves on. Two cases the web never meets:

- **Paused in the background for a long time.** The broker remembers a
  session for 12 hours, but Jellyfin stops its own transcoder after a
  period of inactivity, and the registry is in-process, so a redeploy
  empties it. A film paused at 01:10 and resumed hours later from the
  lock screen may find its segments failing. `VideoSession` treats any
  playlist or segment failure after a long pause as "start a new session
  at the last known position", silently. The saved progress makes this
  cheap.
- **App killed mid-film by iOS.** Progress has been POSTed within the last
  interval; on next launch the film shows in Continue Watching. Nothing
  to do, but the last-position flush on `didEnterBackground` should be
  synchronous (`URLSession` background configuration) rather than
  fire-and-forget.

Subtitles are off, matching the server (no subtitle profile in
`deviceProfile()`). AirPlay works through the standard route picker;
note that AirPlaying a Jellyfin HLS stream to an Apple TV means the
Apple TV fetches segments itself with no bearer — so AirPlay for video is
audio-only (mirroring) until the segment routes accept a short-lived
signed URL. Music AirPlay is unaffected (the phone decodes and sends
audio).

### Screens

Movies (grid with shelves: Continue watching, Favourites, Recently added;
film detail with versions, badges, soundtracks, heart, play), Shows (grid;
show detail with seasons, per-episode play, continue-watching row), Music
(index by format as the web does, artist, album with format tabs limited
to the digital copy, favourites, playlists with drag reorder), Now Playing
(cover, transport, scrubber, shuffle/repeat, heart, add to playlist,
queue with swipe-to-remove and drag), Account (name, household, passkeys
later, sign out). Search is local over the loaded index, which the web
lacks (PLAN.md) — cheap here because the index is already in memory.

Design: the site's dark theme and type (`globals.css` tokens ported to a
`Theme` file), poster-forward grids, the same badge vocabulary
(`FormatBadge`, `ResolutionBadge`, `HdrBadge`, `AudioCodecBadge` recreated
as SwiftUI views from the same label helpers).

### Distribution

**TestFlight, internal testers.** A household app behind a web of trust
has no App Store audience and review would need a demo account into a
private library. TestFlight internal testing (up to 100 people on the
developer account's team, no review, 90-day builds, re-uploaded by CI)
fits a family. The Apple Developer Program membership is the only cost.
If it ever goes further, App Store *unlisted distribution* is the route,
not a public listing.

## Rollout phases (rough effort)

| Phase | What | Est. (days) |
|---|---|---|
| 0 | **Server: bearer sessions.** `bearer()` plugin, proxy accepts the header, tests. `GET /api/v1/me`. `GET /api/audio/:id/file`. Verify with `curl` end to end: send code, sign in, fetch a cover and a track with the bearer. | 1 |
| 1 | **Server: `/api/v1` reads.** Films, shows, music index/artist/album/favourites/playlists as read-only routes over the existing queries; `api-v1-types.ts`. | 1 |
| 2 | **App: sign-in + music + background audio.** Project, `MediaVaultKit`, OTP sign-in, Keychain, music browse, `AudioPlayer` on `AVQueuePlayer`, `QueueModel` port with tests, mini player and Now Playing sheet, the full background checklist. Ends with the gapless check on a live album and a whole-album listen with the phone locked. | 4 |
| 3 | **Server + app: mutations.** Move action bodies to `lib`, add the favourite/playlist routes, wire hearts, playlist CRUD, add-to-playlist and reorder in the app. | 2 |
| 4 | **App: video.** Film/show screens, `VideoSession`, `AVPlayerViewController`, quality and audio menus, resume, progress, PiP, background-audio detach, the long-pause re-session. | 3 |
| 5 | **Hardening.** Interruptions, route changes, cellular hand-off, relaunch-from-headphones, iPad layout, accessibility labels, error surfaces (503 stream cap, 401 → sign-in), TestFlight pipeline (Xcode Cloud or a `fastlane` lane). | 2 |
| 6 | **Passkeys.** AASA route + proxy exception, native passkey sign-in, "add this device" from Account. | 1 |

Phases 0–2 are the milestone that answers the brief: music that keeps
playing when the app isn't in the foreground. 3–4 bring parity; 5–6 make
it a thing the household can rely on.

## Things that could go wrong (and where they're caught)

- **`AVQueuePlayer` gaps on MP3 or oddly-encoded AAC.** Caught in phase
  2's live-album check. Fallback is the `AVAudioEngine` port behind the
  same protocol (see "Music playback engine"); the PCM route already
  exists for it.
- **Cloudflare and range requests.** The Tunnel passes ranges through
  today (the web's direct-play `/stream` depends on it), but audio files
  are new traffic; confirm a `206` with `curl -r` in phase 0 before any
  Swift is written. Cloudflare's 100 MB body cap is above any track.
- **Bearer tokens and the rate limiter.** BetterAuth's rate limit keys on
  IP; the app's launch-time `get-session` plus a burst of image fetches
  must not trip the `/api/auth/*` window. Only `/api/auth/*` is rate
  limited by the plugin, and only one call per launch goes there.
- **Session lifetime.** BetterAuth's default is 7 days, extended on use;
  a phone that opens the app weekly stays signed in, one left for a
  month re-enters a code. Acceptable; a longer `expiresIn` for
  bearer-created sessions is a config line if it grates.
- **Jellyfin's stream cap (`JELLYFIN_MAX_SESSIONS`, default 2).** A
  session counts as live for three minutes after its last segment fetch,
  so a phone paused in the background stops counting on its own. The app
  still sends `jf/stop` when a backgrounded film has been paused for a
  few minutes and re-sessions on resume (see "Video"), so the transcoder
  isn't left running for nobody.
- **The 4-core VM.** Music now costs no ffmpeg, so a phone listening
  while someone watches a transcode is strictly better than the web
  doing the same.
- **AirPlay video to an Apple TV** fetches segments without our bearer —
  documented above as mirroring-only until signed segment URLs exist.
- **Proxy change surface.** Accepting `Authorization` in `src/proxy.ts`
  is the one security-relevant edit; it must verify the HMAC exactly as
  for the cookie and must not bypass the `DENIED_AUTH_PREFIXES` 404s.
  `route-guards.test.ts` plus new proxy tests cover it, and
  `requireMemberOrResponse` remains the authorisation, as today.

## Explicitly deferred (not in this plan)

- **Offline downloads.** Straightforward later (the app fetches original
  files; a background `URLSession` download into the container and a
  local `AVPlayerItem` is all it takes, and Jellyfin HLS can use
  `AVAssetDownloadTask`), but it needs a storage-budget UI and a
  licensing think about ripped discs leaving the house. Not needed for
  background playback.
- **CarPlay browse UI** (needs the CarPlay audio entitlement; the Now
  Playing screen works without it via `MPNowPlayingInfoCenter`).
- **Widgets, Live Activities, Siri intents, Handoff.**
- **Music listening history** until the server has a route (PLAN.md).
- **Chromecast / Google Cast**, **Android**.
- **Moving MediaVaultTV onto `MediaVaultKit` and bearer/device-code
  sign-in** — enabled by this plan, not part of it.
- **Owner features, physical-media data entry, the Adult library** — the
  web app.

## Docs to update

- `README.md`: a "Companion app" line under *What it does*, the new
  environment-free auth note (bearer sessions), and this file in the
  documentation table.
- `PLAN.md`: mark "Native-client API" as designed here; note `/api/v1`
  as the versioned surface tvOS should move to.
- `DEPLOYMENT.md`: the AASA route and that it must be reachable over the
  Tunnel without a session (phase 6).
- `docs/TEST_PLAN_2026-09.md`-style manual pass for the background
  checklist, on a real iPhone, over cellular.
