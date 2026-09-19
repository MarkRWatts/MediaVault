# filmDB — single web app image. Keeps the full node_modules tree (like re:Fresh)
# rather than Next's pruned "standalone" output: Prisma's CLI (needed at boot for
# `migrate deploy`) drags in its own dependency tree that standalone's trace
# doesn't pick up, and copying node_modules as a whole directory (rather than
# cherry-picking individual packages) is what keeps internal symlinks —
# e.g. node_modules/.bin/prisma — intact across the copy. better-sqlite3 is a
# native module requiring build tools; ffprobe/ffmpeg (jellyfin-ffmpeg, pinned
# below) are installed in the runner for ground-truth video metadata and
# on-demand playback.
#
# Both stages are Debian bookworm, not Alpine: jellyfin-ffmpeg ships no musl
# build (see V4_PLAN.md "ffmpeg: jellyfin-ffmpeg, pinned"), and better-sqlite3
# is compiled in the builder against the same libc the runner ships, so the
# two stages must always move together.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# Anonymous build telemetry off.
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts

# better-sqlite3 requires node-gyp to compile: python, make, g++.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# --legacy-peer-deps: better-auth declares better-sqlite3@^12 as a peer for
# its own (unused here) native SQLite dialect — this project uses the Prisma
# adapter instead, on better-sqlite3@^13, so the conflict is harmless.
RUN npm ci --legacy-peer-deps

# Generate Prisma client to src/generated (gitignored).
RUN npx prisma generate

# .dockerignore keeps every .env* except the two committed templates out of
# this copy — the real .env.docker must never land in an image layer.
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ffmpeg/ffprobe/vainfo: the jellyfin-ffmpeg8 .deb (github.com/jellyfin/
# jellyfin-ffmpeg), pinned by version and verified by SHA-256 below — see
# V4_PLAN.md "ffmpeg: jellyfin-ffmpeg, pinned". It bundles its own matched
# libva + Intel iHD driver under /usr/lib/jellyfin-ffmpeg/ (including
# vainfo, used by DEPLOYMENT.md's iGPU check), carries the fMP4/HLS muxer
# and QSV/VAAPI patches the playback engine is developed against, and is
# what the reference Jellyfin instance logs its known-good ffmpeg command
# lines against. Installed via `apt-get install <path-to-deb>` (not
# `dpkg -i`) so its own runtime deps (libx264, libvpx, the VA-API stack,
# none of which bookworm-slim ships) resolve straight from the Debian
# repos instead of being hand-picked here. curl and ca-certificates exist
# only to fetch and verify the package and are purged again once it's
# installed, so they don't linger in the image. tini is PID 1 (below) so a
# `docker stop` (every deploy) reaches the app as SIGTERM instead of `sh`
# swallowing it and the runtime SIGKILLing everything 10s later -- which
# killed any in-flight ffmpeg mid-write and left its multi-GB .partial
# behind (see src/lib/video-cache.ts's shutdown hook). wget is the
# healthcheck's probe below (bookworm-slim ships neither tini nor wget by
# default, unlike Alpine). openssl is installed by name, not left to arrive
# as a dependency: Prisma's schema engine (the `migrate deploy` on every
# start) picks its binary by detecting the OpenSSL version, bookworm-slim
# has none of its own, and the curl/ca-certificates purge below would
# otherwise auto-remove it again -- the container then looks for a
# `debian-openssl-1.1.x` engine that was never installed and restart-loops.
# Done before the app COPYs so this layer is cached across app rebuilds.
ARG TARGETARCH
RUN set -eux; \
  JELLYFIN_FFMPEG_VERSION=8.1.2-5; \
  case "$TARGETARCH" in \
    amd64) JELLYFIN_FFMPEG_SHA256=0669ff65b1eaafdbbcc341181f2c26a8922c3a04ee4190be1f19d27f4d3e054d ;; \
    arm64) JELLYFIN_FFMPEG_SHA256=8e0771de539a893072663ff0cd1aff7455a4031cef24d8fa8acb77c7451ff247 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  JELLYFIN_FFMPEG_DEB="jellyfin-ffmpeg8_${JELLYFIN_FFMPEG_VERSION}-bookworm_${TARGETARCH}.deb"; \
  apt-get update; \
  apt-get install -y --no-install-recommends tini wget openssl ca-certificates curl; \
  curl -fsSL -o /tmp/jellyfin-ffmpeg.deb \
    "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JELLYFIN_FFMPEG_VERSION}/${JELLYFIN_FFMPEG_DEB}"; \
  echo "${JELLYFIN_FFMPEG_SHA256}  /tmp/jellyfin-ffmpeg.deb" | sha256sum -c -; \
  apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb; \
  apt-get purge -y --auto-remove curl ca-certificates; \
  rm -rf /tmp/jellyfin-ffmpeg.deb /var/lib/apt/lists/*

# Point the app at the pinned binaries above rather than $PATH (src/lib/
# ffmpeg-bin.ts is the one place that reads these; local dev leaves both
# unset and falls back to a bare "ffmpeg"/"ffprobe" PATH lookup).
ENV FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg
ENV FFPROBE_PATH=/usr/lib/jellyfin-ffmpeg/ffprobe

# Everything the app owns is chowned to the image's unprivileged `node`
# user (uid/gid 1000) so the server never runs as root: it shells out to
# ffmpeg on user-driven inputs and serves the internet, and a code-exec bug
# in either should not hand out root inside the container. /app/data is the
# mount point of the data volume; the volume itself must be owned by
# 1000:1000 too (see DEPLOYMENT.md "Running as non-root").
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
# src/ + scripts/ + tsconfig.json aren't needed to run the built app itself,
# but are needed for owner-run admin tooling (e.g. scripts/gen-access-code.ts,
# see HOUSEHOLDS_PLAN.md) to work in production via
# `docker compose exec app node_modules/.bin/tsx scripts/<name>.ts` — tsx
# needs tsconfig.json present to resolve this project's `@/*` path alias.
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
RUN mkdir -p /app/data && chown node:node /app /app/data

USER node

EXPOSE 3000

# /signin is the cheapest page that exercises the full stack (Next + the
# database via BetterAuth's session lookup) and is reachable signed-out.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/signin > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply any pending migrations, then start the server. Safe to run on every
# boot: migrate deploy is a no-op when the schema is already up to date.
# `exec` replaces the shell with the server process so tini's signal
# forwarding lands on Node itself. Both binaries are invoked straight from
# node_modules/.bin rather than via npx: npx wants a writable cache under
# $HOME, which a read-only root filesystem (docker-compose.prod.yml)
# doesn't give the `node` user.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node_modules/.bin/next start"]
