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

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# src/ + scripts/ + tsconfig.json aren't needed to run the built app itself,
# but are needed for owner-run admin tooling (e.g. scripts/gen-access-code.ts,
# see HOUSEHOLDS_PLAN.md) to work in production via
# `docker compose exec app npx tsx scripts/<name>.ts` — tsx needs tsconfig.json
# present to resolve this project's `@/*` path alias.
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# ffprobe/ffmpeg for ground-truth video metadata in the scanner and the
# on-demand playback remux/transcode. tini as PID 1 so a `docker stop` (every
# deploy) reaches the app as SIGTERM instead of `sh` swallowing it and the
# runtime SIGKILLing everything 10s later -- which killed any in-flight
# ffmpeg mid-write and left its multi-GB .partial behind (see
# src/lib/video-cache.ts's shutdown hook).
RUN apk add --no-cache ffmpeg tini

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
# Apply any pending migrations, then start the server. Safe to run on every
# boot: migrate deploy is a no-op when the schema is already up to date.
# `exec` replaces the shell with the server process so tini's signal
# forwarding lands on Node itself; node_modules/.bin/next is the same binary
# `npm start` would run, minus npm's own layer in between.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node_modules/.bin/next start"]
