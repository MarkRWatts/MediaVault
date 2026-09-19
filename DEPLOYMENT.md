# MediaVault — Deployment

How to run MediaVault locally in Docker and how it is deployed in
production: its own Proxmox VM, `mediavault-vm`, set up and updated
entirely by Ansible. One container, SQLite in a named volume, the NAS share
mounted as a CIFS volume, the VM's own Caddy in front on the LAN, and the
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

## The production VM

| | |
| --- | --- |
| VM | `mediavault-vm`, VMID 653 on the Proxmox host proxmox01 |
| Address | 192.168.6.53, VLAN 6 (internet-facing apps, isolated from the main LAN) |
| Size | 4 GB RAM, CPU type `host` |
| Managed by | The Ansible repo [ansible-proxmox01](https://github.com/MarkRWatts/ansible-proxmox01), checked out at `~/claude-code/ansible-homelab`; house guide `~/claude-code/DOCKER-DEPLOY-PLAYBOOK.md` |
| Checkout | `~/MediaVault` (`/home/deploy/MediaVault`), `main` |
| Compose | `docker-compose.yml` + `docker-compose.prod.yml`, project `mediavault` |

Ansible owns the checkout, `.env.docker`, the stack and the VM's Caddy.
Nothing is done on the VM by hand except owner-run scripts,
logs, restores and pruning (see [Break-glass
access](#break-glass-access)). MediaVault used to run on the shared
`srvclaudedockerapps` server; it no longer runs there.

### Deploying and updating

Push to `main`, then run the playbook for this VM:

```bash
git push origin main
cd ~/claude-code/ansible-homelab
ansible-playbook playbook.yml --limit mediavault-vm
```

The playbook pulls `main` with the VM's read-only GitHub deploy key,
rebuilds and restarts the container only when the commit changed, and then
checks both sites (`mediavault.markrwatts.com` and
`jellyfin.markrwatts.com`) over HTTPS through the VM's Caddy.

The container's boot runs `prisma migrate deploy`, so migrations apply on
every restart and an empty volume gets a fresh `mediavault.db`. Backfill
scripts that a release needs are noted in its commit message and run the
same way as the [owner-run scripts](#owner-run-scripts) below.

### Secrets (`.env.docker`)

`.env.docker` is never committed and never edited on the VM. Its full
contents live in the Ansible vault, `host_vars/mediavault-vm/vault.yml`
under the key `vault_app_env_file`, and the playbook writes it into the
checkout. It holds the SMB credentials, `TMDB_API_KEY`, the Jellyfin
settings, the BetterAuth secret and URL, the Resend key and
`ALLOWED_EMAILS`. To change it:

```bash
cd ~/claude-code/ansible-homelab
ansible-vault edit host_vars/mediavault-vm/vault.yml
ansible-playbook playbook.yml --limit mediavault-vm
```

[.env.docker.example](.env.docker.example) remains the commented template.

### Media share

No host mount and no sudo: `docker-compose.prod.yml` declares the share as
a CIFS named volume, so the Docker daemon mounts
`//$MOVIES_SMB_HOST/$MOVIES_SMB_SHARE` read-only with a dedicated read-only
SMB account, and the container sees it at `/media-share`. `MOVIES_PATH`,
`TVSHOWS_PATH` and `MUSIC_PATH` point inside it. The base compose's
`/movies` bind is satisfied by an empty placeholder directory
(`MOVIES_HOST_PATH=/home/deploy/MediaVault-empty`, which Docker creates).

The NAS is reached on the TrueNAS box's 2.5 GbE NIC, 192.168.1.11
(`truenas.markrwatts.com`):

- `MOVIES_SMB_HOST=192.168.1.11` must be an IP, not a hostname. The Docker
  local driver passes it to the kernel's CIFS mount as `addr=`, which does
  not resolve names.
- `JELLYFIN_URL=http://192.168.1.11:8096`.
- VLAN 6 cannot reach the main LAN, so a UniFi firewall policy allows only
  192.168.6.53 → 192.168.1.11 on TCP 445 (SMB) and 8096 (Jellyfin). If the
  mount fails or Jellyfin playback stops, check that policy first.

### Owner-run scripts

Sign in with an address from `ALLOWED_EMAILS`. On a fresh database, grant
the app-owner role (Scan, Report and Admin stay hidden until this runs);
over [break-glass SSH](#break-glass-access):

```bash
cd ~/MediaVault
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml \
  exec app node_modules/.bin/tsx scripts/grant-app-owner.ts you@example.com
```

Then scan and enrich from `/admin`. Every other script in the README runs
the same way (see [Running as non-root](#running-as-non-root) for why it is
`tsx` and not `npx`).

**Jellyfin SSO** (optional, one-time) needs the app reachable on its real
HTTPS URL, because OIDC discovery requires it, and Jellyfin on its own
HTTPS name, `jellyfin.markrwatts.com`, whose certificate the VM's Caddy
provides (see [HTTPS on the LAN](#https-on-the-lan-the-vms-caddy)). See
README → Jellyfin.

### Verify

The playbook already checks both sites. By hand:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://mediavault.markrwatts.com/   # 200
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app   # on the VM: "No pending migrations to apply"
```

### Running as non-root

The image runs the server as the unprivileged `node` user (uid/gid 1000)
with a read-only root filesystem, no capabilities and `no-new-privileges`;
`/tmp` and Next's cache are tmpfs mounts with mode 1777. Two consequences:

1. **The data volume must be owned by 1000:1000.** Once, before the first
   non-root deploy on a volume created by an older root-running container,
   and again after a restore:
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

### Break-glass access

```bash
ssh -i ~/.ssh/dockerapps_deploy_ed25519 deploy@192.168.6.53
```

`deploy` is in the `docker` group and has no sudo. Use it for owner-run
scripts, logs and restores, not for deploying: anything changed by hand in
the checkout or `.env.docker` is overwritten by the next playbook run.

## HTTPS on the LAN (the VM's Caddy)

The VM runs its own Caddy (Ansible role `edge`), which serves two sites:

- `mediavault.markrwatts.com` → `mediavault:3000`, the alias `app` carries
  on the `edge` Docker network (`docker-compose.prod.yml`).
- `jellyfin.markrwatts.com` → `192.168.1.11:8096`, Jellyfin on TrueNAS.
  This is where Jellyfin's real HTTPS certificate on the LAN comes from,
  which the Jellyfin SSO/OIDC flow needs. Jellyfin itself stays on TrueNAS.

Both certificates are issued by DNS-01 through their existing acme-dns
accounts, so both `_acme-challenge` CNAMEs (`_acme-challenge.mediavault`
and `_acme-challenge.jellyfin`) must stay in DNS. The site list is
`edge_sites` in ansible-proxmox01 `host_vars/mediavault-vm/vars.yml`; the
acme-dns credentials are in the same directory's `vault.yml`. Change
either, then run the playbook.

Caddy rewrites `X-Forwarded-For` to the client's LAN IP as a single value,
which the app accepts as the rate-limit key when `cf-connecting-ip` is
absent.

## Internet exposure (Cloudflare Tunnel)

Live since 10 September 2026. Internet traffic arrives through
`home-edge`, the shared Cloudflare Tunnel, whose connector runs on its own
VM, `tunnel-vm` (VMID 651, 192.168.6.51, Ansible role `tunnel`); there is
no per-app `cloudflared` and no tunnel token in this repository.

1. **Published application route.** Cloudflare → Zero Trust → Networks →
   Tunnels → `home-edge` → Published application routes:
   `mediavault.markrwatts.com` → `https://192.168.6.53`, with TLS → Origin
   Server Name set to `mediavault.markrwatts.com`. The Origin Server Name
   is required: without it the connector sends the IP as SNI and the TLS
   handshake with Caddy fails. Cloudflare creates a proxied CNAME; delete
   any plain `A` record for the name first. `BETTER_AUTH_URL` stays
   `https://mediavault.markrwatts.com`; the app derives `__Secure-`
   cookies, the passkey origin and trusted origins from it.

   There is no Cloudflare Access gate in front of MediaVault; the app's own
   sign-in is the only gate. Jellyfin has no public route.
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
4. **The LAN path.** Pi-hole local DNS records point
   `mediavault.markrwatts.com` and `jellyfin.markrwatts.com` straight at
   the VM, 192.168.6.53, bypassing Cloudflare entirely. This keeps in-home
   streaming off the Cloudflare round trip and is why the admin block above
   can be unconditional. If Chrome on the LAN shows an SSL protocol error,
   the resolver is leaking an AAAA record to Cloudflare; add a
   `local=/mediavault.markrwatts.com/` override.
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
commented per variable. The VM's real values live in the Ansible vault (see
[Secrets](#secrets-envdocker)). Points specific to the VM:

- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are required; the prod overlay
  refuses to start without them.
- `DATABASE_URL`, `POSTER_CACHE_DIR`, `VIDEO_CACHE_DIR` and `AUDIO_CACHE_DIR` are fixed inside
  the data volume by the base compose file.
- `MOVIES_PATH`, `TVSHOWS_PATH` and `MUSIC_PATH` are overridden by the prod
  overlay to paths inside the CIFS volume.
- `MOVIES_SMB_HOST`, `MOVIES_SMB_SHARE`, `MOVIES_SMB_USERNAME` and
  `MOVIES_SMB_PASSWORD` feed the CIFS volume; `MOVIES_SMB_HOST` must be an
  IP (192.168.1.11), not a hostname. `MOVIES_HOST_PATH` is the empty
  placeholder for the base bind mount.
- `JELLYFIN_URL` is `http://192.168.1.11:8096`, allowed through the
  firewall policy above.
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
removed. It was moved from the old server byte for byte on 15 September
2026 (integrity check ok, 48 tables). `mediavault_movies` is only the CIFS
mount definition, recreated from `.env.docker`; it holds no data and is
never copied or backed up.

### Backups

Proxmox backs up the whole VM twice a day to the host's `backup-hdd`
storage (the scheduled job that covers every VM). With one app per VM, that
covers the `mediavault_data` volume, database included. The VM runs the
QEMU guest agent, so Proxmox freezes its filesystems during each snapshot,
which gives a consistent copy of the SQLite files. Nothing is backed up
inside the VM: there is no backup cron or script there (in-VM backups are
the Ansible `roles/app` setting `app_backup_enabled`, default `false`).

A one-off copy of the database can still be taken by hand when wanted,
with sqlite3's online `.backup` via the `keinos/sqlite3` image (the app
image has no sqlite3); nothing does this automatically. The database is
sensitive: live session tokens, the JWKS private key that signs Jellyfin's
OIDC tokens, the OAuth client secret and hashed sign-in codes. Encrypt any
copy taken off the VM; [`age`](https://github.com/FiloSottile/age) with a
passphrase is the least ceremony:

```bash
age -p -o mediavault.db.age mediavault.db
```

### Restore

Restore the VM from a Proxmox backup: proxmox01 → `backup-hdd` → Backups,
pick a backup of `mediavault-vm`, Restore. For bad data without rolling
back the whole VM, restore to a new VMID instead and copy the data out of
its `mediavault_data` volume. To put it back on the live VM over
[break-glass SSH](#break-glass-access), stop the app first:

```bash
cd ~/MediaVault
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml stop app
```

Replace the files in the `mediavault_data` volume with the copied-out ones
(keep `mediavault.db` together with any `-wal`/`-shm` files beside it).
Then chown the volume again (see [Running as non-root](#running-as-non-root))
and start the app:

```bash
docker run --rm -v mediavault_data:/data alpine chown -R 1000:1000 /data
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml start app
```

If the disk fills, the video cache is safe to empty while the app runs:

```bash
docker run --rm -v mediavault_data:/data alpine sh -c 'rm -rf /data/video-cache/*'
```

### Docker build cache

Every rebuild leaves its layer cache behind, and on the VM this grows
faster than anything the app writes. Prune it now and then over
break-glass SSH, especially if a deploy or transcode complains about disk
space:

```bash
docker builder prune -f
```
