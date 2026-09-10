# MediaVault — Deployment

How to run MediaVault locally in Docker and how it is deployed on the
production VM: an Ubuntu Server guest on TrueNAS that also runs the
household's other apps. One container, SQLite in a named volume, the NAS
share mounted as a CIFS volume, a shared Caddy in front on the LAN, and a
shared Cloudflare Tunnel for the internet.

## Local development

Day to day, use `npm run dev` (see README). To run the production image
locally with the SMB share mounted at `/Volumes/media/Movies`:

```bash
cd ~/claude-code/MediaVault
docker compose up -d --build
# http://localhost:3002
```

`docker-compose.yml` and `docker-compose.override.yml` load automatically.
The override publishes port 3002 (3000 and 3001 belong to other local
apps). Logs and teardown:

```bash
docker compose logs -f app
docker compose down
```

## VM deployment

The shared Caddy stack must exist first (see [Shared reverse
proxy](#shared-reverse-proxy-edge)).

1. **Get the code.**
   ```bash
   git clone https://github.com/MarkRWatts/MediaVault.git ~/MediaVault
   ```
2. **Create `.env.docker`** on the server from `.env.docker.example`. Never
   commit it. It holds the SMB credentials, `TMDB_API_KEY`, the Jellyfin
   settings, the BetterAuth secret and URL, the Resend key and
   `ALLOWED_EMAILS`.
3. **Media share.** No host mount and no sudo: `docker-compose.prod.yml`
   declares the share as a CIFS named volume, so the Docker daemon mounts
   `//$MOVIES_SMB_HOST/$MOVIES_SMB_SHARE` read-only with a dedicated
   read-only SMB account, and the container sees it at `/media-share`.
   `MOVIES_PATH`, `TVSHOWS_PATH` and `MUSIC_PATH` point inside it. The base
   compose's `/movies` bind is satisfied by an empty placeholder directory
   (`MOVIES_HOST_PATH`).

   Networking gotcha: a VM attached via macvtap to the same physical NIC as
   the TrueNAS host's IP cannot reach the host at all, and the mount fails
   with "no route to host". Give the VM a different physical NIC (verify by
   MAC, not interface name) or use a proper bridge.
4. **Bring the stack up.**
   ```bash
   docker network create edge   # once
   cd ~/MediaVault
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   cd ~/edge && docker compose up -d --build
   ```
   The container's boot runs `prisma migrate deploy`, creating
   `mediavault.db` on an empty volume.
5. **Verify.**
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" https://mediavault.markrwatts.com/   # 200
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app   # "No pending migrations to apply"
   ```
6. **First sign-in and owner role.** Sign in with an address from
   `ALLOWED_EMAILS`, then grant the app-owner role (Scan, Report and Admin
   stay hidden until this runs):
   ```bash
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml \
     exec app node_modules/.bin/tsx scripts/grant-app-owner.ts you@example.com
   ```
   Then scan and enrich from `/admin`.
7. **Jellyfin SSO** (optional, one-time) needs the app reachable on its real
   HTTPS URL, because OIDC discovery requires it. See README → Jellyfin.

### Updating

```bash
ssh deploy@192.168.1.77
cd ~/MediaVault
git pull
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations apply on boot. Backfill scripts that a release needs are noted
in its commit message and run the same way as `grant-app-owner.ts` above.

### Running as non-root

The image runs the server as the unprivileged `node` user (uid/gid 1000)
with a read-only root filesystem, no capabilities and `no-new-privileges`;
`/tmp` and Next's cache are tmpfs mounts with mode 1777. Two consequences:

1. **The data volume must be owned by 1000:1000.** Once, before the first
   non-root deploy on a volume created by an older root-running container:
   ```bash
   docker run --rm -v mediavault_data:/data alpine chown -R 1000:1000 /data
   ```
2. **Owner-run scripts call `tsx` directly**, not through `npx`, which wants
   a writable cache under `$HOME`:
   ```bash
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml \
     exec app node_modules/.bin/tsx scripts/gen-access-code.ts --email someone@example.com
   ```

The CIFS volume options include `uid=1000,gid=1000` for the same reason.

## Shared reverse proxy (`~/edge`)

A single Caddy instance on the VM fronts every app there. It lives at
`~/edge` on the server, outside any app's repository. One-time setup for
MediaVault:

1. Create the external network: `docker network create edge`.
2. Register the hostname with acme-dns:
   ```bash
   curl -X POST https://auth.acme-dns.io/register
   ```
   Save the returned `username`, `password` and `subdomain` in `~/edge/.env`
   as `MEDIAVAULT_ACMEDNS_USERNAME`, `MEDIAVAULT_ACMEDNS_PASSWORD` and
   `MEDIAVAULT_ACMEDNS_SUBDOMAIN`.
3. DNS: a CNAME from `_acme-challenge.mediavault` to that subdomain.
4. Add the site block to `~/edge/Caddyfile`:
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
   `mediavault` is the alias `app` carries on the `edge` network.
5. Reload: `cd ~/edge && docker compose up -d --build`.

Caddy rewrites `X-Forwarded-For` to the client's LAN IP as a single value,
which the app accepts as the rate-limit key when `cf-connecting-ip` is
absent.

## Internet exposure (Cloudflare Tunnel)

Live since 10 September 2026. Internet traffic arrives through
`home-edge`, a Cloudflare Tunnel connector already running on the VM and
shared by every app there; there is no per-app `cloudflared` and no tunnel
token in this repository.

1. **Published application route.** Cloudflare → Zero Trust → Networks →
   Tunnels → `home-edge` → Published application routes: add
   `mediavault.markrwatts.com` → `http://mediavault:3000`. Cloudflare creates
   a proxied CNAME; delete any plain `A` record for the name first.
   `BETTER_AUTH_URL` stays `https://mediavault.markrwatts.com`; the app
   derives `__Secure-` cookies, the passkey origin and trusted origins from
   it.
2. **Block admin and scan from the internet.** Security → WAF → Custom
   rules: block
   `(http.host eq "mediavault.markrwatts.com") and (starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/scan"))`.
   The LAN path below never touches Cloudflare, so these pages are
   LAN-only, including for the owner away from home.
3. **WAF and rate limiting** (still outstanding as of 10 September 2026):
   turn on the Cloudflare Managed Ruleset; rate-limit `/api/auth/*` to
   10 requests a minute per IP with a 10-minute block and `/api/*` to 300 a
   minute per IP; bypass the cache for `/api/video/*`, `/api/tv-video/*`,
   `/api/audio/*` and `/api/auth/*`.
4. **The LAN path.** LAN devices resolve the hostname straight to the VM
   through a router-level DNS override, bypassing Cloudflare entirely. This
   keeps in-home streaming off the Cloudflare round trip and is why the
   admin block above can be unconditional. If Chrome on the LAN shows an
   SSL protocol error, the resolver is leaking an AAAA record to Cloudflare;
   add a `local=/mediavault.markrwatts.com/` override.
5. **Verify** from outside the LAN:
   ```bash
   curl -sSI https://mediavault.markrwatts.com/signin | grep -iE "strict-transport|x-frame|content-security|cf-ray"
   curl -sS -o /dev/null -w "%{http_code}\n" -H 'Cookie: __Secure-better-auth.session_token=forged' https://mediavault.markrwatts.com/api/films   # 401
   curl -sS -o /dev/null -w "%{http_code}\n" https://mediavault.markrwatts.com/admin   # 403
   ```

Viewers arriving through the tunnel default to Remote video quality and do
not see the LAN-only "Play in Jellyfin" links.

## Environment variables

The two templates are the reference: [.env.example](.env.example) for
local dev and [.env.docker.example](.env.docker.example) for the VM, both
commented per variable. Points specific to the VM:

- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are required; the prod overlay
  refuses to start without them.
- `DATABASE_URL`, `POSTER_CACHE_DIR` and `VIDEO_CACHE_DIR` are fixed inside
  the data volume by the base compose file.
- `MOVIES_PATH`, `TVSHOWS_PATH` and `MUSIC_PATH` are overridden by the prod
  overlay to paths inside the CIFS volume.
- `MOVIES_SMB_HOST`, `MOVIES_SMB_SHARE`, `MOVIES_SMB_USERNAME` and
  `MOVIES_SMB_PASSWORD` feed the CIFS volume; `MOVIES_HOST_PATH` is the
  empty placeholder for the base bind mount.
- `JELLYFIN_MAX_SESSIONS`, `PREPARE_CONCURRENCY`, `PREPARE_QUEUE` and
  `AUDIO_CONCURRENCY` cap concurrent transcodes and decodes; the defaults
  suit a 4-core VM.
- No `FFPROBE_DOCKER_IMAGE`: the image installs ffmpeg.
- `AUDIODB_API_KEY` and `FANART_API_KEY` currently do nothing (see
  `PLAN.md` → Housekeeping).

## Data persistence and backups

The SQLite database, cached artwork and the parked pipeline's video cache
live in the `mediavault_data` named volume (pinned by name in
`docker-compose.yml` so a project rename cannot orphan it), mounted at
`/app/data`. It survives restarts and redeploys unless the volume is
removed.

`video-cache/` is a pure derivative of the media share and must not be
backed up. The database is sensitive: live session tokens, the JWKS
private key that signs Jellyfin's OIDC tokens, the OAuth client secret and
hashed sign-in codes. Keep archives owner-only and encrypted at rest;
[`age`](https://github.com/FiloSottile/age) with a passphrase is the least
ceremony (`apt install age`):

```bash
umask 077
docker run --rm -v mediavault_data:/data alpine \
  tar cz -C /data --exclude=./video-cache . \
  | age -p -o "$HOME/mediavault-data-$(date +%Y-%m-%d).tar.gz.age"
find "$HOME" -maxdepth 1 -name 'mediavault-data-*.tar.gz*' -mtime +14 -delete
```

Restore, then chown the volume again (see [Running as non-root](#running-as-non-root)):

```bash
age -d "$HOME/mediavault-data-YYYY-MM-DD.tar.gz.age" \
  | docker run --rm -i -v mediavault_data:/data alpine tar xz -C /data
```

If the disk fills, the video cache is safe to empty while the app runs:

```bash
docker run --rm -v mediavault_data:/data alpine sh -c 'rm -rf /data/video-cache/*'
```

### Docker build cache

Every `up -d --build` leaves its layer cache behind, and on an 80 GB VM
this grows faster than anything the app writes. Prune it now and then,
especially if a deploy or transcode complains about disk space:

```bash
docker builder prune -f
```
