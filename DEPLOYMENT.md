# MediaVault — Deployment

This documents how to run MediaVault locally and deploy it to the production VM — an Ubuntu Server on TrueNAS, the same host that runs jobAppTracker. The setup mirrors jobAppTracker's pattern exactly, adapted for SQLite (no separate database container) and the movie share volume.

## Local development

On the Mac, with the SMB share mounted at `/Volumes/media/Movies`:

```bash
cd ~/claude-code/filmDB
docker compose up -d --build
# Then browse to http://localhost:3002
```

The base `docker-compose.yml` and `docker-compose.override.yml` are auto-loaded (no `-f` flags needed). The override publishes port 3002 locally (3000 and 3001 are taken by re:Fresh and jobAppTracker). Logs:

```bash
docker compose logs -f app
```

Tear down:

```bash
docker compose down
```

## VM deployment

On the production VM (see [Shared reverse proxy](#shared-reverse-proxy-edge) below to set up the shared Caddy stack once):

### 1. Get the code

```bash
git clone https://github.com/MarkRWatts/MediaVault.git ~/MediaVault
```

Future deploys are just `git pull` + rebuild (see [Updating](#updating-the-deployment) below).

### 2. `.env.docker`

Create `.env.docker` directly on the server (never committed — copy
`.env.docker.example` for the full variable list): SMB credentials for the
share, `TMDB_API_KEY`, and the Jellyfin settings.

### 3. Movie share

No host mount and **no sudo needed**: `docker-compose.prod.yml` declares the
share as a CIFS **named volume**, so the Docker daemon itself mounts
`//$MOVIES_SMB_HOST/$MOVIES_SMB_SHARE` (read-only, credentials from
`.env.docker` — use a dedicated read-only SMB account) and the container sees
it at `/media-share`, with `MOVIES_PATH=/media-share/Movies`. The base
compose's `/movies` bind is satisfied by an empty placeholder dir
(`MOVIES_HOST_PATH=/home/deploy/MediaVault-empty`).

**Networking gotcha (learned the hard way)**: if the VM runs *on* the same
box that serves the SMB share (TrueNAS), a VM attached via macvtap to the
same physical NIC as the host's IP **cannot reach the host at all** — mount
attempts fail with "no route to host". Give the VM a different physical NIC
than the one carrying the host's IP (verify by MAC, not interface name), or
use a proper bridge interface.

### 4. Bring up the stack

The shared Caddy stack must exist first (see [Shared reverse proxy](#shared-reverse-proxy-edge) below). Then:

```bash
docker network create edge   # once — skip if it already exists
cd ~/MediaVault
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
cd ~/edge && docker compose up -d --build   # brings up the shared Caddy
```

`app`'s boot-time `prisma migrate deploy` runs the schema initialization (the first time the volume is empty, creating `mediavault.db`).

### 5. Verify

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://mediavault.markrwatts.com/   # 200
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app   # "No pending migrations to apply"
```

Then scan the movie share and enrich with TMDB data from a browser on a LAN device (the `/report` page shows progress).

### 6. Jellyfin SSO (optional, one-time)

Only possible once the app is up and reachable over its real HTTPS URL —
OIDC discovery requires that. See README.md "Jellyfin SSO (optional)" for
the setup steps (a form on `/admin`, run once per Jellyfin instance).

## Updating the deployment

On the VM:

```bash
ssh deploy@192.168.1.77
cd ~/MediaVault
git pull
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Shared reverse proxy (`~/edge`)

A single Caddy instance on the VM fronts **every** app — currently jobAppTracker and MediaVault (and more). It lives at `~/edge` on the server directly, not in either app's git repo, since it isn't owned by any one app. See jobAppTracker's `DEPLOYMENT.md` for the full setup and the `Caddyfile` structure.

**One-time setup** (if you haven't set up the edge stack for jobAppTracker yet):

1. Create the external Docker network:
   ```bash
   docker network create edge
   ```

2. Set up the edge stack at `~/edge` (see jobAppTracker's `DEPLOYMENT.md` for details).

3. For MediaVault, register it with acme-dns (one-time per app):
   ```bash
   curl -X POST https://auth.acme-dns.io/register
   ```

   Returns `username`, `password`, `subdomain`, `fulldomain`. Save these to `~/edge/.env` as:
   ```
   MEDIAVAULT_ACMEDNS_USERNAME=...
   MEDIAVAULT_ACMEDNS_PASSWORD=...
   MEDIAVAULT_ACMEDNS_SUBDOMAIN=...
   ```

4. Add DNS records at your domain registrar:
   - CNAME: `_acme-challenge.mediavault` → the `MEDIAVAULT_ACMEDNS_SUBDOMAIN` returned above
   - A: `mediavault` → your VM's static IP (e.g., `192.168.1.77`)

5. Add a site block to the shared Caddyfile (at `~/edge/Caddyfile`):
   ```
   mediavault.markrwatts.com {
       tls {
           dns acmedns {
               username {$MEDIAVAULT_ACMEDNS_USERNAME}
               password {$MEDIAVAULT_ACMEDNS_PASSWORD}
               subdomain {$MEDIAVAULT_ACMEDNS_SUBDOMAIN}
               server_url https://auth.acme-dns.io
           }
       }
       reverse_proxy mediavault:3000
   }
   ```

6. Reload Caddy:
   ```bash
   cd ~/edge && docker compose up -d --build
   ```

## Running as non-root

The image runs the server as the unprivileged `node` user (uid/gid 1000)
with a read-only root filesystem, no capabilities and `no-new-privileges`
(`Dockerfile`, `docker-compose.prod.yml`). Two consequences on an existing
deployment:

1. **The data volume must be owned by 1000:1000.** It was created by the
   old root-running container, so do this once before the first
   non-root deploy (the app can't create `mediavault.db` or write posters
   otherwise):
   ```bash
   docker run --rm -v mediavault_data:/data alpine chown -R 1000:1000 /data
   ```
2. **Owner-run scripts call `tsx` directly**, not through `npx` (which
   wants a writable cache under `$HOME` that the read-only filesystem
   doesn't give it):
   ```bash
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml \
     exec app node_modules/.bin/tsx scripts/gen-access-code.ts --email someone@example.com
   ```

The CIFS volume options include `uid=1000,gid=1000` for the same reason.

## Exposing to the internet (Cloudflare Tunnel)

The LAN setup above terminates TLS on the VM's Caddy behind a private-IP
DNS record. To make the app reachable from anywhere **without** opening a
port, run a Cloudflare Tunnel connector next to the app
(`docker-compose.cloudflared.yml`) and let Cloudflare front it. Do these in
order; the app-side hardening this depends on (real session checks on
every route, HMAC-verified session cookie at the proxy, `cf-connecting-ip`
as the rate-limit key, security headers) is already in the code.

### 1. Create the tunnel

Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a
tunnel** (Cloudflared connector). Copy the token from the "Install and run
a connector" step into `.env.docker` as `CLOUDFLARE_TUNNEL_TOKEN`. Under
**Public Hostname** add `mediavault.markrwatts.com` → service
`http://app:3000` (the compose service name; cloudflared shares the app's
network). Cloudflare creates the proxied CNAME for you — delete the old
private-IP `A` record for the same name if you keep it public only via the
tunnel, or see "LAN path" below.

`BETTER_AUTH_URL` stays `https://mediavault.markrwatts.com`; the app derives
`__Secure-` cookies, the passkey origin and `trustedOrigins` from it.

### 2. Bring it up

```bash
cd ~/MediaVault
docker compose --env-file .env.docker \
  -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cloudflared.yml up -d --build
```

The `cloudflared` container waits for `app`'s healthcheck before
connecting. `docker compose … logs cloudflared` should show
"Registered tunnel connection".

### 3. Put Cloudflare Access in front (strongly recommended)

Zero Trust → Access → Applications → **Add an application** → Self-hosted,
domain `mediavault.markrwatts.com`. Policy: **Allow**, include *Emails* =
the same list as `ALLOWED_EMAILS` plus every household member (or *Emails
ending in* your family domain), login method *One-time PIN*. Session
duration a week is fine — this is a second factor in front of the app's own
sign-in, and it keeps unauthenticated traffic (scanners, credential
stuffing against `/api/auth/*`) from ever reaching the origin.

At minimum, if you want the app's own sign-in to be the only gate, protect
`/admin*` and `/scan*` with an Access policy restricted to the app owner.

### 4. WAF and rate limiting

Security → WAF:

- **Managed rules**: turn on the Cloudflare Managed Ruleset (free tier
  includes the essentials).
- **Rate limiting rules** (the app's own limits cover sign-in only, and
  Next.js has none built in):
  - `/api/auth/*` — 10 requests / minute / IP, block for 10 minutes.
  - `/api/*` — 300 requests / minute / IP (HLS segments are small and
    frequent; a player fetches one every ~6 s per stream).
- **Cache Rules**: bypass cache for `/api/video/*`, `/api/tv-video/*`,
  `/api/audio/*` and `/api/auth/*`. Video through the proxy is a lot of
  bytes; check your plan's limits on non-HTML traffic and the 100 s
  origin-response timeout (the HLS playlist route waits up to 30 s for a
  first segment, which is inside it).

### 5. The LAN path

With the tunnel up, the old direct route (LAN DNS → Caddy → `app`) still
works if you keep the private-IP `A` record and the `edge` network. It
bypasses Access, WAF and rate limiting — fine for devices on the home
network, but decide that explicitly. To make the origin tunnel-only,
remove the Caddy site block and the `edge` network membership from
`docker-compose.prod.yml`; nothing else is listening on the host.

If Caddy stays in front on the LAN, it rewrites `X-Forwarded-For` to the
client's LAN IP (single value), which the app accepts as a fallback when
`cf-connecting-ip` is absent — so rate limiting keys correctly on both
paths.

### 6. Verify

From outside the LAN (phone on mobile data):

```bash
curl -sSI https://mediavault.markrwatts.com/signin | grep -iE "strict-transport|x-frame|content-security|cf-ray"
curl -sS -o /dev/null -w "%{http_code}\n" -H 'Cookie: __Secure-better-auth.session_token=forged' https://mediavault.markrwatts.com/api/films   # 401 (or Access's 302 if Access is on)
```

## Renaming an existing filmDB deployment to MediaVault (one-time)

This app was previously deployed as **filmDB**. The rename touches the repo,
the directory, the Docker volume, the network alias, and the Caddy site
block — do these together on the VM, in this order, so there's no window
where the container looks like a fresh install with an empty database.

DNS and the acme-dns CNAME for `mediavault.markrwatts.com` have already been
added (reusing the existing filmDB acme-dns registration/credentials — no
new external registration needed, since it's the same app under a new
name). `filmdb.markrwatts.com` and its `_acme-challenge` CNAME are still live
and untouched; remove them only after step 8 below confirms the new hostname
works.

1. **Stop the old stack** (don't remove the volume):
   ```bash
   cd ~/filmDB
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml down
   ```

2. **Migrate the data volume.** The compose file previously let Docker derive
   the volume name from the project directory (`filmdb_data`); it's now
   pinned explicitly to `mediavault_data` (see `docker-compose.yml`) so this
   never happens silently again. Copy the data across, **then rename the
   database file inside the new volume** to match the new `DATABASE_URL`
   (`mediavault.db`) — skipping this step leaves the real data at
   `mediavault_data/filmdb.db`, unused, while `prisma migrate deploy` quietly
   creates a fresh *empty* `mediavault.db` next to it, which looks like a
   successful boot with a silently empty library:
   ```bash
   docker volume create mediavault_data
   docker run --rm -v filmdb_data:/from -v mediavault_data:/to alpine \
     sh -c "cp -a /from/. /to/"
   docker run --rm -v mediavault_data:/v alpine mv /v/filmdb.db /v/mediavault.db
   ```
   Leave `filmdb_data` in place as a rollback copy until the new deployment
   is verified (step 8), then remove it.

3. **Rename the directory and re-point the remote:**
   ```bash
   mv ~/filmDB ~/MediaVault
   cd ~/MediaVault
   git remote set-url origin https://github.com/MarkRWatts/MediaVault.git
   git pull
   ```

4. **Rename the placeholder bind-mount dir** referenced by
   `MOVIES_HOST_PATH` in `.env.docker`:
   ```bash
   mv /home/deploy/filmDB-empty /home/deploy/MediaVault-empty
   ```
   and update `MOVIES_HOST_PATH` in `.env.docker` to match.

5. **Add the new acme-dns env vars to `~/edge/.env`**, reusing the existing
   filmDB credential values under the new names:
   ```
   MEDIAVAULT_ACMEDNS_USERNAME=<same value as FILMDB_ACMEDNS_USERNAME>
   MEDIAVAULT_ACMEDNS_PASSWORD=<same value as FILMDB_ACMEDNS_PASSWORD>
   MEDIAVAULT_ACMEDNS_SUBDOMAIN=<same value as FILMDB_ACMEDNS_SUBDOMAIN>
   ```
   (The old `FILMDB_ACMEDNS_*` vars can stay until step 9's cleanup.)

6. **Add the new Caddy site block** (the one in [Shared reverse
   proxy](#shared-reverse-proxy-edge) above) to `~/edge/Caddyfile`, alongside
   — not replacing — the existing `filmdb.markrwatts.com` block for now.

7. **Bring the renamed stack up and reload Caddy:**
   ```bash
   cd ~/MediaVault
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   cd ~/edge && docker compose up -d --build
   ```

8. **Verify** — the container should come up against the *migrated* data,
   not a fresh empty database:
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" https://mediavault.markrwatts.com/   # 200
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app   # "No pending migrations to apply"
   ```
   Then open it in a browser and confirm the library/shows/music counts match
   what filmDB had before the rename (no "0 films" / empty-library state).

9. **Clean up** once the above checks out:
   - Remove the old `filmdb.markrwatts.com` Caddy block from `~/edge/Caddyfile` and reload Caddy.
   - Remove `FILMDB_ACMEDNS_*` from `~/edge/.env`.
   - Delete the DNS records for `filmdb.markrwatts.com` and `_acme-challenge.filmdb.markrwatts.com` in Cloudflare.
   - `docker volume rm filmdb_data` (only once you're confident `mediavault_data` has everything).
   - `rm -rf /home/deploy/filmDB-empty` if step 4's `mv` didn't already relocate it.

## Environment variables

### Local dev (Mac, in `.env`)

- `DATABASE_URL`: Usually `file:./data/mediavault.db` (file path or SQLite connection string).
- `MOVIES_PATH`: `/Volumes/media/Movies` (or wherever the SMB share is mounted).
- `POSTER_CACHE_DIR`: `./data/posters` (where downloaded TMDB posters are cached).
- `FFPROBE_DOCKER_IMAGE`: `mwader/static-ffmpeg:latest` (fallback if ffprobe isn't on PATH; leave unset when the Docker image installs ffmpeg).
- `TMDB_API_KEY`: Free key from https://www.themoviedb.org/settings/api (optional; leave blank for scan-only).

### VM deployment (in `.env.docker`)

- `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`: required — the prod overlay refuses to start without them.
- `CLOUDFLARE_TUNNEL_TOKEN`: only with `docker-compose.cloudflared.yml` (see [Exposing to the internet](#exposing-to-the-internet-cloudflare-tunnel)).
- `DATABASE_URL`: `file:/app/data/mediavault.db` (set in the base `docker-compose.yml`).
- `MOVIES_PATH`: `/media-share/Movies` on the VM (the CIFS named volume; the base compose default `/movies` applies only to local dev).
- `POSTER_CACHE_DIR`: `/app/data/posters` (set in the base `docker-compose.yml`).
- `MOVIES_SMB_HOST/SHARE/USERNAME/PASSWORD`: the CIFS named-volume credentials (see `.env.docker.example`); `MOVIES_HOST_PATH` points at an empty placeholder dir.
- `TMDB_API_KEY`: Free key (optional; leave blank for scan-only).
- `DISCOGS_TOKEN`: Optional — Discogs is the sole music metadata source (see
  `src/lib/discogs.ts`); no key is required for read-only lookups at this
  app's scale, but setting one is strongly recommended before a
  full-catalogue Enrich Music pass (25/min unauthenticated vs 60/min with a
  token set).
- `AUDIODB_API_KEY` / `FANART_API_KEY`: Currently unused — TheAudioDB/
  Fanart.tv artist bio/photo/backdrop enrichment (see `src/lib/artist-bio.ts`)
  was keyed by a MusicBrainz artist id, which no longer exists post-Discogs-
  cutover; only the Wikipedia-by-name bio/photo tier still runs. Left in
  place for a future revisit, not currently worth setting.

No `FFPROBE_DOCKER_IMAGE` needed — the runner image installs ffmpeg.

## Data persistence

The SQLite database (`mediavault.db`) and cached TMDB posters live in the `mediavault_data` named Docker volume (pinned explicitly in `docker-compose.yml` — see the [rename migration](#renaming-an-existing-filmdb-deployment-to-mediavault-one-time) note above for why), mounted at `/app/data` inside the container. On the VM, this volume is stored on the host filesystem (usually `/var/lib/docker/volumes/mediavault_data/_data`), so it persists across container restarts and redeploys (as long as you don't `docker volume rm`).

The same volume also holds `video-cache/` — the on-demand ffmpeg
remux/transcode output (up to `VIDEO_CACHE_MAX_BYTES`, 10 GiB by default,
plus any in-flight file). That's a pure derivative of the media share and
must **not** be backed up: a backup that includes it is 10+ GB every time,
and a daily one fills an 80 GB VM disk in about a week. Exclude it, and
rotate old archives:

```bash
docker run --rm -v mediavault_data:/data -v "$HOME":/backup alpine \
  tar czf /backup/mediavault-data-$(date +%Y-%m-%d).tar.gz -C /data --exclude=./video-cache .
find "$HOME" -maxdepth 1 -name 'mediavault-data-*.tar.gz' -mtime +14 -delete
```

The cache layout changed with HLS playback (`PLAYBACK_PLAN.md`): entries are
now directories (`film-42/`, `film-42-remote/`), and the app sweeps
anything else in the cache dir — including the old single-file `*.mp4`
output — on its first playback call after a deploy. So the first play of
each film after that deploy prepares again; nothing to do by hand.

If the disk has already filled, the cache is safe to empty outright while
the app is running — anything mid-play is re-prepared on the next Play:

```bash
docker run --rm -v mediavault_data:/data alpine sh -c 'rm -rf /data/video-cache/*'
```

To restore from a backup:

```bash
docker run --rm -v mediavault_data:/data -v "$HOME":/backup alpine tar xzf /backup/mediavault-data-YYYY-MM-DD.tar.gz -C /data
```

### Docker build cache

Every `up -d --build` in [Updating the deployment](#updating-the-deployment)
leaves its layer cache behind, and on an 80 GB VM this grows much faster
than `video-cache/` ever does — `docker system df` has shown 20+ GB of
build cache (mostly reclaimable) versus a few GB of actual video cache.
It's unrelated to the app's own housekeeping (E of `docs/TEST_PLAN_2026-09.md`
only covers `video-cache/`), so prune it by hand occasionally, especially
if a prepare is refused for lack of disk space:

```bash
docker builder prune -f
```
