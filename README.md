<p align="center">
  <img src="docs/logo.png" alt="MediaVault" width="320" />
</p>

A household index of a DVD/Blu-ray film and TV collection stored on a NAS
SMB share (also served by Jellyfin), plus a Discogs-backed music library with
physical CD/vinyl pressing tracking. It scans the share, probes every file
with ffprobe for real resolution and soundtracks, enriches from TMDB/Discogs,
and presents a poster-forward library with collection timelines,
season-by-season show pages, in-browser playback, and a "what's missing"
collector's report — shared across a household, each member with their own
sign-in and watch history.

- **Library** — every owned film, searchable/filterable, with format
  (4K/Blu-ray/DVD) and resolution badges. A film can be tagged as owned on a
  physical medium independent of whether it's been ripped, and a barcode
  scanner page (camera or a USB scanner gun) looks up a physical item against
  the library while you're stood in front of the shelf.
- **Film detail** — editions (theatrical vs director's cut), resolutions,
  soundtracks (Dolby/DTS profile badges, HDR labels), file details,
  in-browser playback (on-demand ffmpeg remux/transcode, streamed while it's
  still being prepared — no separate encode-then-wait step), and per-version
  "Play in Jellyfin" links.
- **Shows** — TV series with per-season episode lists, missing episodes
  greyed out, in-browser playback, and per-episode play links. Episode
  numbering follows disc order (TMDB DVD episode groups), because this is a
  disc library.
- **Music** — artists with studio back-catalogues from Discogs, owned vs
  missing albums shown by colour, lossless/codec + quality badges
  (`ALAC · 16/44.1`). An album page switches between the Digital copy and
  any physical CD/vinyl pressings you own — each pressing can be linked to
  its own Discogs release for its own tracklist, catalogue number, and cover
  art (falling back to the digital files' own embedded artwork) — alongside
  **gapless in-browser album playback** — lossless end-to-end (ALAC is
  served as FLAC, sample-accurate Web Audio track joins, no transcoding of
  lossy files).
- **Collections** — film series (James Bond, Alien, …) in release-order
  timelines with missing films greyed out.
- **Report** — missing films per collection, missing seasons/episodes per
  show, Blu-ray upgrade candidates, and files needing metadata attention.
- **Stats** — per-member watch history and viewing stats.
- **Households** — email one-time-code sign-in (no passwords), invite-based
  membership so the library is shared with family without a separate account
  per service, and an owner-only admin area for managing members and
  integrations.

## Screenshots

| Library | Film detail |
| --- | --- |
| ![Library grid](docs/screenshots/library.png) | ![Film detail with versions and soundtracks](docs/screenshots/film-detail.png) |

| Collections | Collection timeline |
| --- | --- |
| ![Collections grid](docs/screenshots/collections.png) | ![Release-order timeline with missing films greyed](docs/screenshots/collection-timeline.png) |

| Show detail | Report |
| --- | --- |
| ![Season-by-season episode lists](docs/screenshots/show-detail.png) | ![Collector's report with collapsible sections](docs/screenshots/report.png) |

| Music library | Artist back catalogue |
| --- | --- |
| ![Artist grid with embedded cover art and owned/total counts](docs/screenshots/music-library.png) | ![Decade-grouped studio albums, owned vs missing](docs/screenshots/music-artist.png) |

<p align="center">
  <img src="docs/screenshots/music-album.png" alt="Album detail with per-disc track list, quality badges, and the gapless player" width="900" />
</p>

<p align="center">
  <img src="docs/screenshots/report-expanded.png" alt="Missing-from-collections section expanded, showing gap posters per collection" width="900" />
</p>

## Stack

Next.js 16 (App Router) · Prisma 7 + SQLite · Tailwind v4 · BetterAuth ·
ffprobe/ffmpeg · TMDB API · Discogs API · Jellyfin API. See
[PLAN.md](PLAN.md) for design decisions,
[HOUSEHOLDS_PLAN.md](HOUSEHOLDS_PLAN.md) for the auth/households design, and
[DEPLOYMENT.md](DEPLOYMENT.md) for Docker/VM deployment (shared-Caddy `edge`
network pattern).

## Configuration

Everything external is an environment variable — no hostnames or paths are
hardcoded. Local dev reads `.env` (template: [.env.example](.env.example));
the Docker deployment reads `.env.docker` on the server (template:
[.env.docker.example](.env.docker.example)).

### Media paths

| Variable | Meaning |
| --- | --- |
| `MOVIES_PATH` | Folder of movie files the scanner walks (e.g. `/Volumes/media/Movies` locally, `/media-share/Movies` in the container). |
| `TVSHOWS_PATH` | Folder of TV shows (`Show (Year)/Season NN/Show SxxEyy.ext`). Optional — unset skips all TV features. |
| `MUSIC_PATH` | Folder of a music library in iTunes layout (`Artist/Album/NN Track.m4a`). Optional — unset skips all music features. |
| `POSTER_CACHE_DIR` | Where downloaded TMDB/Discogs artwork is cached. |
| `VIDEO_CACHE_DIR` | Where on-demand ffmpeg remux/transcode output is cached, keyed per file — a prepared file is served straight from here on every subsequent play. |
| `VIDEO_CACHE_MAX_BYTES` | Cap on that cache's total size; oldest-played files are evicted first once it's full. Defaults to 10 GiB if unset. |
| `DATABASE_URL` | SQLite location, e.g. `file:./data/mediavault.db`. |
| `FFPROBE_DOCKER_IMAGE` | Dev-only fallback: run ffprobe via `docker run` when it isn't on PATH (the deploy image installs ffmpeg). |

### Authentication (required)

Every route requires a signed-in household member — there is no
unauthenticated mode. Sign-in is email one-time-code via
[BetterAuth](https://www.better-auth.com/), so email-sending is a hard
prerequisite, not optional config. See
[HOUSEHOLDS_PLAN.md](HOUSEHOLDS_PLAN.md) for the full design. Once signed
in, each member can add a passkey per device from `/account` (Face ID,
Touch ID, Windows Hello, a security key) and skip the email code on that
device from then on — an optional extra, never a replacement; the email
code always still works. Passkeys need HTTPS (or `localhost`), so a
plain-http LAN address won't offer them. See
[PASSKEYS_PLAN.md](PASSKEYS_PLAN.md).

| Variable | Meaning |
| --- | --- |
| `BETTER_AUTH_SECRET` | Session/cookie signing key. Generate with `npx @better-auth/cli secret`. |
| `BETTER_AUTH_URL` | The app's own public base URL, for building callback/redirect links. Must be a real HTTPS URL in production (also required for Jellyfin SSO discovery, below). |
| `RESEND_API_KEY` | [Resend](https://resend.com) API key — sends the sign-in one-time-code emails. |
| `ALLOWED_EMAILS` | Comma-separated email address(es), case-insensitive — the web of trust's root anchor (the app owner's own address(es)). This is the one access grant no database state can lock out. |

### SMB share (Docker deployment only)

The production compose mounts the NAS share as a CIFS named volume — the
Docker daemon performs the mount, so no host mount or sudo is needed. Use a
dedicated read-only SMB account.

| Variable | Meaning |
| --- | --- |
| `MOVIES_SMB_HOST` | NAS hostname or IP. |
| `MOVIES_SMB_SHARE` | Share name holding the Movies / TV Shows folders. |
| `MOVIES_SMB_USERNAME` / `MOVIES_SMB_PASSWORD` | Read-only SMB credentials. |
| `MOVIES_HOST_PATH` | Local-dev bind source; on the server, an empty placeholder dir. |

### TMDB

| Variable | Meaning |
| --- | --- |
| `TMDB_API_KEY` | Free key or v4 read token from themoviedb.org → Settings → API. Optional — without it the app is scan-only (no posters, metadata, collections, or missing-content detection). |

### Discogs (optional)

Discogs is the sole music metadata source (albums, tracklists, physical
pressing details/cover art).

| Variable | Meaning |
| --- | --- |
| `DISCOGS_TOKEN` | Personal access token from discogs.com → Settings → Developers. Optional — unauthenticated lookups work at this app's scale, but a token raises the rate limit from 25/min to 60/min, worth it before a full-catalogue Enrich Music pass. |

### Artist enrichment (optional)

Biography text, portrait photo, and backdrop image for each artist —
multi-source with graceful fallback; a missing/failed source just leaves
that field unset.

| Variable | Meaning |
| --- | --- |
| `AUDIODB_API_KEY` | [TheAudioDB](https://www.theaudiodb.com) key. Optional — the shared public test key works fine at this app's scale. |
| `FANART_API_KEY` | [Fanart.tv](https://fanart.tv) key, for higher-quality backdrop art specifically. No shared key exists — this source is skipped entirely unless set. |

### Jellyfin (optional)

| Variable | Meaning |
| --- | --- |
| `JELLYFIN_URL` | Jellyfin base URL, e.g. `http://<nas>:8096`. |
| `JELLYFIN_API_KEY` | Token from Dashboard → API Keys. Unset disables the integration gracefully. |
| `JELLYFIN_MOVIES_PREFIX` | Path prefix Jellyfin's movie items carry before the relative file path (default `/media/Movies/`). |
| `JELLYFIN_TV_PREFIX` | Same for TV episodes (default `/media/TV Shows/`). |

A sync job matches Jellyfin items to files by path (Unicode-normalized, so
macOS-scanned NFD paths match Linux NFC ones), runs automatically after every
scan, and powers the per-version/per-episode "Play in Jellyfin" links.

### Jellyfin SSO (optional)

Lets household members sign into Jellyfin with their MediaVault account
instead of a separate Jellyfin password, via
[jellyfin-plugin-sso](https://github.com/9p4/jellyfin-plugin-sso). No new
env vars — `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET` (below) already cover it.

One-time setup, from `/admin`'s "Integrations" section (app owner only):

1. Install jellyfin-plugin-sso on the Jellyfin server if it isn't already.
2. In MediaVault's `/admin`, enter Jellyfin's SSO redirect URI — of the form
   `https://<jellyfin-host>/sso/OID/redirect/<ProviderName>` — and submit.
   You get back a `client_id`/`client_secret`, shown once.
3. In jellyfin-plugin-sso's provider config, set the OIDC endpoint to
   `{BETTER_AUTH_URL}/api/auth` (jellyfin-plugin-sso appends
   `/.well-known/openid-configuration` itself) and paste in the
   `client_id`/`client_secret` from step 2. Requires `BETTER_AUTH_URL` to be
   a real, publicly reachable HTTPS URL — discovery won't work over plain
   HTTP or `localhost`.

See `HOUSEHOLDS_PLAN.md` "Post-deploy addition: Jellyfin SSO" for the
implementation notes.

## Development

```bash
cp .env.example .env       # fill in paths + keys
npm install
npx prisma migrate dev
npm run dev                # http://localhost:3000
```

Trigger scans from the UI, or hit the API routes directly — each requires an
authenticated owner session (e.g. pass the browser's session cookie along
with `curl`, or just use the UI's "Scan"/"Enrich" buttons, which is simpler
for one-off runs):

```bash
curl -X POST localhost:3000/api/scan/film     # add ?force=1 to re-probe everything
curl -X POST localhost:3000/api/scan/tv
curl -X POST localhost:3000/api/scan/music
curl -X POST localhost:3000/api/enrich/film
curl -X POST localhost:3000/api/enrich/tv
curl -X POST localhost:3000/api/enrich-music
curl -X POST localhost:3000/api/jellyfin-sync
```

## Tests

```bash
npx vitest run
```

The filename parsers are tested against the real quirks of a lived-in library:
missing years, `[imdbid-…]`/`[tmdbid-…]` tags, edition brackets, underscores,
glued tags, typo'd extensions, unpadded season folders, flat show layouts, and
multi-episode files.

### Passkeys end to end

A WebAuthn ceremony needs an authenticator, so the passkey flows have their
own browser-driven check (see [PASSKEYS_PLAN.md](PASSKEYS_PLAN.md)). It
starts its own throwaway `next dev` on a scratch SQLite database and drives
Chromium with a virtual authenticator — nothing touches your real
`.env`, database, or email. Once per machine:

```bash
npx playwright install chromium
```

then:

```bash
npx tsx scripts/e2e-passkey.ts
```

Takes about a minute. `E2E_PORT` picks the throwaway server's port
(default 3007); `E2E_CHROMIUM` points at a specific Chromium binary.
