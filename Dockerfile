# filmDB — single web app image. Keeps the full node_modules tree (like re:Fresh)
# rather than Next's pruned "standalone" output: Prisma's CLI (needed at boot for
# `migrate deploy`) drags in its own dependency tree that standalone's trace
# doesn't pick up, and copying node_modules as a whole directory (rather than
# cherry-picking individual packages) is what keeps internal symlinks —
# e.g. node_modules/.bin/prisma — intact across the copy. better-sqlite3 is a
# native module requiring build tools; ffprobe (from ffmpeg) is installed in the
# runner for ground-truth video metadata.

FROM node:22-alpine AS builder
WORKDIR /app
# Anonymous build telemetry off.
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts

# better-sqlite3 requires node-gyp to compile: python, make, g++.
RUN apk add --no-cache python3 make g++
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

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ffprobe/ffmpeg for ground-truth video metadata in the scanner and the
# on-demand playback remux/transcode. tini as PID 1 so a `docker stop` (every
# deploy) reaches the app as SIGTERM instead of `sh` swallowing it and the
# runtime SIGKILLing everything 10s later -- which killed any in-flight
# ffmpeg mid-write and left its multi-GB .partial behind (see
# src/lib/video-cache.ts's shutdown hook). Done before the app COPYs so the
# apk layer is cached across app rebuilds.
RUN apk add --no-cache ffmpeg tini

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

ENTRYPOINT ["/sbin/tini", "--"]
# Apply any pending migrations, then start the server. Safe to run on every
# boot: migrate deploy is a no-op when the schema is already up to date.
# `exec` replaces the shell with the server process so tini's signal
# forwarding lands on Node itself. Both binaries are invoked straight from
# node_modules/.bin rather than via npx: npx wants a writable cache under
# $HOME, which a read-only root filesystem (docker-compose.prod.yml)
# doesn't give the `node` user.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node_modules/.bin/next start"]
