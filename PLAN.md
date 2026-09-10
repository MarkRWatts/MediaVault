# MediaVault — Architecture and current state

Last reviewed 10 September 2026. This is the map of how the app is built
today and what is still worth building. The design records for the larger
rollouts are separate files (`HOUSEHOLDS_PLAN.md`, `PASSKEYS_PLAN.md`,
`PLAYBACK_PLAN.md`, `PLAYLISTS_PLAN.md`, `SIDEBAR_PLAN.md`); this file
summarises the result rather than the path.

## Purpose

One shared catalogue of a household's DVD/Blu-ray rips, TV box sets and
music, indexed from a NAS SMB share that Jellyfin also serves. The
founding decisions still hold: ground truth comes from the files
themselves (ffprobe, not filenames), metadata is enriched from public APIs
and cached locally so the app is self-contained afterwards, "missing"
items are real rows so gaps can be browsed like owned items, and the UI is
dark and poster-forward.

## Stack

- **Next.js 16** App Router with React 19 and TypeScript. Server
  Components read Prisma directly; mutations are server actions or route
  handlers. `src/proxy.ts` (this Next.js version's middleware) gates every
  request on a signed session cookie. Read the guides in
  `node_modules/next/dist/docs/` before writing Next code; this version
  differs from older conventions.
- **Prisma 7 + SQLite** through `@prisma/adapter-better-sqlite3`. One
  database file in the data volume, `prisma migrate deploy` at boot, 36
  migrations to date. Generated client lives in `src/generated/prisma`.
- **Tailwind 4** with the app's own dark tokens; container queries size the
  poster grids to the width beside the sidebar and rail.
- **BetterAuth 1.7** with the `emailOTP`, `organization` (renamed to
  Household/Member/Invitation), `passkey`, `jwt` and `oauthProvider`
  plugins. Resend sends the sign-in codes.
- **ffprobe/ffmpeg** in the runtime image; local dev without them shells
  out through `FFPROBE_DOCKER_IMAGE`.
- **External APIs**: TMDB (films, shows, collections, certificates),
  Discogs (all music metadata, barcodes, pressings), Spotify (artist
  photos), Wikipedia (artist biography fallback), UPCitemdb (movie
  barcodes), Jellyfin (playback, library sync, SSO).
- **Client libraries**: hls.js for video on non-Apple browsers, the Web
  Audio API for music, `@zxing/browser` for the camera barcode scanner,
  lucide-react icons.

## Data model

Shared library (nothing here is per user):

- **Films**: `Film` (one identity, owned or missing), `Version` (one file
  on disk with format, resolution, codec, HDR range, Jellyfin id),
  `AudioTrack` (per version, with default and audio-description
  dispositions), `FilmPhysicalCopy` (a DVD, Blu-ray or UHD disc on the
  shelf, independent of any rip), `Collection` (TMDB collection).
- **TV**: `Show`, `ShowSeason`, `Episode` (owned or missing, disc-order
  numbering), `EpisodeFile` (file with specs and Jellyfin id).
- **Music**: `Artist` (Discogs id, Spotify id, photo, bio), `Album` (owned
  or a Discogs back-catalogue placeholder; cover art, digital source,
  Discogs identity), `Track` (file, codec, bit depth, sample rate),
  `PhysicalCopy` (a CD or vinyl pressing, optionally linked to its own
  Discogs release), `PhysicalTrack` (that pressing's tracklist).
- **Runs**: `ScanRun` (one row per scan, enrich or sync run, with progress
  and a JSON log), `ScanQueueItem` (barcodes scanned but not yet resolved,
  shared across devices).

Accounts and access (BetterAuth-generated plus app additions):

- `User` (with `isAppOwner`, sidebar and rail preferences, a cached
  Jellyfin user id), `Session`, `Account`, `Verification`, `Passkey`.
- `Household`, `Member`, `Invitation`; `AccessCode`; `AuditLog`
  (content-free record of who did what kind of action).
- OIDC provider tables (`Jwks`, `OauthClient`, tokens, consents) for
  Jellyfin SSO.

Personal layer (per user, cascade-deleted with the user):

- `FilmFavourite`, `ShowFavourite`, `TrackFavourite`, `AlbumFavourite`,
  `ArtistFavourite`.
- `Playlist` and `PlaylistItem`; a playlist may carry a `sourceAlbumId` or
  `sourceArtistId` when it was auto-created by favouriting.
- `WatchProgress`: resume position, completion and play count for a film
  `Version` or an `EpisodeFile` (exactly one of the two set per row).

## Pipelines

All run server-side, one at a time per kind, with progress visible on
`/admin` and triggered from there or from the owner-only API routes.

- **Scan** (`src/lib/scanner.ts`): walks the movie, TV and music roots,
  parses the tolerant filename grammar (`src/lib/parse*.ts`), probes each
  new or changed file with ffprobe, and upserts rows. Track ids are stable
  across rescans, which is what makes favourites and playlists safe.
- **Enrich film and TV** (`src/lib/tmdb.ts`): match by IMDb or TMDB id,
  then title and year; pull details, collection membership, BBFC
  certificates and disc-order episode groups; create missing films and
  episodes; cache artwork.
- **Enrich music** (`src/lib/discogs.ts`, `cover-art.ts`,
  `artist-bio.ts`, `spotify.ts`): match artists and albums on Discogs,
  create back-catalogue placeholders, fetch pressing tracklists and covers,
  pick cover art (embedded art first, then iTunes, then a linked Discogs
  pressing), and fetch artist photos and biographies.
- **Jellyfin sync** (`src/lib/jellyfin.ts`): matches versions and episode
  files to Jellyfin items by normalised path; runs after every scan.
- **Barcode** (`src/lib/scan-resolve.ts`, `barcode-lookup.ts`): resolves a
  scanned UPC/EAN through Discogs (music) or UPCitemdb plus TMDB (film),
  reports whether that item is already owned, and adds it as a physical
  copy or a new physical-only album.

## Playback

### Video: through Jellyfin

Films and episodes play in-app through Jellyfin's transcoder
(`src/lib/jellyfin-playback.ts`, `jf-routes.ts`, the `/api/video/<id>/jf/*`
and `/api/tv-video/<id>/jf/*` routes). MediaVault asks Jellyfin for
PlaybackInfo server-side and proxies the playlist and segments with the API
key stripped, so the browser never sees it. Jellyfin serves a complete VOD
playlist and starts ffmpeg at whatever segment is asked for, which gives
every player a real duration and seeking anywhere. Original quality caps at
120 Mbit/s (video copied, audio transcoded where needed); Remote caps at
4 Mbit/s and 1280 pixels wide, and is the default for a viewer arriving
through the Cloudflare Tunnel. Concurrent sessions are capped by
`JELLYFIN_MAX_SESSIONS`. The player (`VideoPlayer.tsx`) uses the native
HLS player on iOS and the tvOS WebView bridge and hls.js elsewhere, offers
the source's audio tracks, reports progress every 15 seconds and on close,
and resumes from the saved position.

The app's own ffmpeg pipeline (`video-cache.ts`, `video-playback.ts`, the
HLS routes) is parked behind `IN_APP_PLAYBACK=1`, still unit-tested and
still exercised by `scripts/e2e-playback.ts`. `PLAYBACK_PLAN.md` records
the design and why production moved to Jellyfin.

### Music: app-wide gapless engine

`src/lib/player-engine.ts` is a framework-free engine behind
`PlayerProvider` in the app shell, so playback survives navigation. The
server (`src/lib/audio-stream.ts`, `/api/audio/<trackId>?rate=`) decodes
every track with ffmpeg to raw PCM at the browser's own sample rate, 16- or
24-bit to match the source, and streams it as it is produced; the engine
schedules each half-second chunk with the Web Audio clock as it arrives,
so a track starts on its first chunk and joins between tracks are
sample-accurate. Only the current and next track are ever buffered. A
counting semaphore caps concurrent ffmpeg decodes. The engine supports a
queue with play-next and add-to-queue, shuffle, repeat, seek and volume,
and drives the media-session controls.

## UI shell

A floating, collapsible left sidebar shared with the owner's other apps
(`src/components/shell/`): Movies, Shows, Music, Collections, Stats for
every member; Scan, Report, Admin for the app owner; the avatar links to
Account. Mobile gets a top bar and bottom tabs with a More sheet. A
matching right rail carries the music player and playlists and expands
only from the `xl` breakpoint; below `md`, or on any touch device, a
player strip sits above the tabs. Both rails persist their collapsed state
per user. Sign-in, sign-up, invite, onboarding and consent pages render
without chrome.

## Access model

- **Web of trust**: a session is created only for an address vouched for
  by `ALLOWED_EMAILS`, an existing `Member` row, a pending `Invitation`,
  or a live `AccessCode`. The check runs before an OTP is sent and again in
  a session-create hook, so it applies to passkey and SSO sign-ins too.
- **Two ways in**: a new household needs an owner-minted access code on
  `/signup`; an invitee follows a bearer-token link from `/invite/<token>`.
- **Roles**: `User.isAppOwner` gates scanning, enrichment, the report, the
  scan page and `/admin`. `Member.role` (`owner` or `member`) gates
  household management on `/account`. The two are deliberately separate.
- **Proxy gate**: every request outside the sign-in pages and
  `/api/auth/*` needs a session cookie whose HMAC verifies against
  `BETTER_AUTH_SECRET`; the real session and membership check happens in
  each page and route (`src/lib/require-member.ts`). A `route-guards` test
  asserts every page and route calls its guard.
- **Security posture**: BetterAuth's organization HTTP endpoints are denied
  (all household mutations go through server actions); rate limiting is
  keyed on `cf-connecting-ip` behind Cloudflare and on the single-valued
  `x-forwarded-for` on the LAN; strict security headers and a report-only
  CSP; the Jellyfin proxy pins its upstream; ffmpeg work is capped by
  semaphores; the container runs as a non-root user on a read-only
  filesystem. `/admin` and `/scan` are blocked at the Cloudflare edge, so
  they are LAN-only.

## Operations

See `DEPLOYMENT.md`: a single container on the home VM behind the shared
Caddy edge, the NAS share mounted as a CIFS named volume, internet
exposure through the shared Cloudflare Tunnel, encrypted backups of the
data volume, and the owner-run scripts.

## Roadmap

Reviewed against the code on 10 September 2026. Estimates are rough, in
focused days.

### Worth doing next

| Item | Why | What exists | Est. |
|---|---|---|---|
| **Global search** | Only Movies has search, client-side over one list. One box across films, shows, artists, albums and collections is the most-used feature the app lacks. The expanded sidebar has room for it. | Per-model queries | 2 |
| **Scan log and unmatched files on the report** | `ScanRun.log` records every unparseable filename and probe failure and nothing renders it. | The data and `GET /api/runs`; the admin run panel omits the field | 1 |
| **Film "fix this match" form** | Albums have one; a film flagged low-confidence or unmatched can only be corrected by rescanning. | `FixAlbumMatchForm` as the pattern, the `search-movie` route | 1 |
| **Blu-ray to 4K upgrade candidates** | The upgrade list only covers DVD to Blu-ray. | One more predicate in the report query | 0.25 |
| **Music listening history** | Stats cover films and episodes; nothing records what was listened to. | `WatchProgress` and the video player's throttled reporting | 1.5 |
| **Invitation emails** | Invites are still copy-a-link. | Resend is wired for codes; the plugin's `sendInvitationEmail` hook is unset | 0.5 |

### Larger

| Item | Why | What exists | Est. |
|---|---|---|---|
| **Wantlist** | "Missing" is machine-derived; there is no way to add an arbitrary title or mark one ordered or won't-own, so the report never stops listing it. | The `owned=false` rows | 2 |
| **Physical-media logistics** | Shelf location, lent-to, purchase date and price. | `PhysicalCopy` / `FilmPhysicalCopy` and their forms | 1.5 |
| **Jellyfin watch-state sync** | The app's history and Jellyfin's are separate, so continue-watching is wrong for anyone who watches on the TV. | `User.jellyfinUserId`, item ids on every version and episode file | 2 |
| **Native-client API** | The tvOS shell can only read `/api/films` and has no sign-in of its own. BetterAuth's device-authorization plugin is the realistic route. | The film routes as the shape to copy | 3–4 |
| **Scheduled scans and a digest email** | Scans are manual; the app sends no email beyond sign-in. | The run guard, Resend, the recently-added query | 2 |
| **Audit log search, paging and retention** | One consumer reads the last 100 rows and nothing prunes. | `AuditLog` and `/admin` | 1 |
| **Jellyfin SSO via passkey** | The SSO sign-in path is deliberately code-only until the passkey endpoint is confirmed to carry the OAuth query. | `PASSKEYS_PLAN.md` phase 5 | 0.5 |

### Housekeeping

- `AUDIODB_API_KEY` and `FANART_API_KEY` are accepted but do nothing since
  the Discogs cutover removed the MusicBrainz id they keyed on. Either
  re-key TheAudioDB and Fanart.tv on artist name or drop them.
- The CSP ships as report-only; enforce it once a few days pass without
  violations.
- The Cloudflare WAF managed ruleset and rate-limit rules in
  `DEPLOYMENT.md` are still to be switched on.
- A real-device passkey pass (iPhone plus Safari on the Mac, iCloud Keychain
  sync) has not been done since deploy.
