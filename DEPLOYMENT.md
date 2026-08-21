# filmDB — Deployment

This documents how to run filmDB locally and deploy it to the production VM — an Ubuntu Server on TrueNAS, the same host that runs jobAppTracker. The setup mirrors jobAppTracker's pattern exactly, adapted for SQLite (no separate database container) and the movie share volume.

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
git clone https://github.com/MarkRWatts/filmDB.git ~/filmDB
```

Future deploys are just `git pull` + rebuild (see [Updating](#updating-the-deployment) below).

### 2. `.env.docker`

Create `.env.docker` directly on the server (never committed — see `.env.docker.example` if one exists for the variable list):

```bash
MOVIES_HOST_PATH=/mnt/movies   # or wherever the SMB share is mounted on the VM
TMDB_API_KEY=...               # optional; leave blank for scan-only mode
```

### 3. Movie share

Mount the SMB share (`//nas.example.lan/media/Movies`) at the path you set in `MOVIES_HOST_PATH` above. Example for `/mnt/movies`:

```bash
sudo mkdir -p /mnt/movies
sudo mount -t cifs //nas.example.lan/media/Movies /mnt/movies \
  -o username=<user>,password=<pass>,uid=1000,gid=1000
```

Add to `/etc/fstab` to mount on boot:

```
//nas.example.lan/media/Movies /mnt/movies cifs username=<user>,password=<pass>,uid=1000,gid=1000 0 0
```

### 4. Bring up the stack

The shared Caddy stack must exist first (see [Shared reverse proxy](#shared-reverse-proxy-edge) below). Then:

```bash
docker network create edge   # once — skip if it already exists
cd ~/filmDB
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
cd ~/edge && docker compose up -d --build   # brings up the shared Caddy
```

`app`'s boot-time `prisma migrate deploy` runs the schema initialization (the first time the volume is empty, creating `filmdb.db`).

### 5. Verify

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://filmdb.example.com/   # 200
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app   # "No pending migrations to apply"
```

Then scan the movie share and enrich with TMDB data from a browser on a LAN device (the `/report` page shows progress).

## Updating the deployment

On the VM:

```bash
ssh deploy@192.168.1.1
cd ~/filmDB
git pull
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Shared reverse proxy (`~/edge`)

A single Caddy instance on the VM fronts **every** app — currently jobAppTracker and filmDB (and more). It lives at `~/edge` on the server directly, not in either app's git repo, since it isn't owned by any one app. See jobAppTracker's `DEPLOYMENT.md` for the full setup and the `Caddyfile` structure.

**One-time setup** (if you haven't set up the edge stack for jobAppTracker yet):

1. Create the external Docker network:
   ```bash
   docker network create edge
   ```

2. Set up the edge stack at `~/edge` (see jobAppTracker's `DEPLOYMENT.md` for details).

3. For filmDB, register it with acme-dns (one-time per app):
   ```bash
   curl -X POST https://auth.acme-dns.io/register
   ```
   
   Returns `username`, `password`, `subdomain`, `fulldomain`. Save these to `~/edge/.env` as:
   ```
   FILMDB_ACMEDNS_USERNAME=...
   FILMDB_ACMEDNS_PASSWORD=...
   FILMDB_ACMEDNS_SUBDOMAIN=...
   ```

4. Add DNS records at your domain registrar:
   - CNAME: `_acme-challenge.filmdb` → the `FILMDB_ACMEDNS_SUBDOMAIN` returned above
   - A: `filmdb` → your VM's static IP (e.g., `192.168.1.1`)

5. Add a site block to the shared Caddyfile (at `~/edge/Caddyfile`):
   ```
   filmdb.example.com {
       tls {
           dns acmedns {
               username {$FILMDB_ACMEDNS_USERNAME}
               password {$FILMDB_ACMEDNS_PASSWORD}
               subdomain {$FILMDB_ACMEDNS_SUBDOMAIN}
               server_url https://auth.acme-dns.io
           }
       }
       reverse_proxy filmdb:3000
   }
   ```

6. Reload Caddy:
   ```bash
   cd ~/edge && docker compose up -d --build
   ```

## Environment variables

### Local dev (Mac, in `.env`)

- `DATABASE_URL`: Usually `file:./data/filmdb.db` (file path or SQLite connection string).
- `MOVIES_PATH`: `/Volumes/media/Movies` (or wherever the SMB share is mounted).
- `POSTER_CACHE_DIR`: `./data/posters` (where downloaded TMDB posters are cached).
- `FFPROBE_DOCKER_IMAGE`: `mwader/static-ffmpeg:latest` (fallback if ffprobe isn't on PATH; leave unset when the Docker image installs ffmpeg).
- `TMDB_API_KEY`: Free key from https://www.themoviedb.org/settings/api (optional; leave blank for scan-only).

### VM deployment (in `.env.docker`)

- `DATABASE_URL`: `file:/app/data/filmdb.db` (set in the base `docker-compose.yml`).
- `MOVIES_PATH`: `/movies` (set in the base `docker-compose.yml`; this is where the SMB share is bound-mounted inside the container).
- `POSTER_CACHE_DIR`: `/app/data/posters` (set in the base `docker-compose.yml`).
- `MOVIES_HOST_PATH`: `/mnt/movies` (or wherever you mounted the SMB share on the VM — passed to the container).
- `TMDB_API_KEY`: Free key (optional; leave blank for scan-only).

No `FFPROBE_DOCKER_IMAGE` needed — the runner image installs ffmpeg.

## Data persistence

The SQLite database (`filmdb.db`) and cached TMDB posters live in the `data` named Docker volume, mounted at `/app/data` inside the container. On the VM, this volume is stored on the host filesystem (usually `/var/lib/docker/volumes/filmdb_data/_data`), so it persists across container restarts and redeploys (as long as you don't `docker volume rm`).

For off-VM backup, copy the volume to external storage:

```bash
docker run --rm -v filmdb_data:/data -v "$HOME":/backup alpine tar czf /backup/filmdb-data-$(date +%Y-%m-%d).tar.gz -C /data .
```

To restore from a backup:

```bash
docker run --rm -v filmdb_data:/data -v "$HOME":/backup alpine tar xzf /backup/filmdb-data-YYYY-MM-DD.tar.gz -C /data
```
