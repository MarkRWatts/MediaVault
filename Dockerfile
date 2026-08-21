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
RUN npm ci

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

# ffprobe for ground-truth video metadata in the scanner.
RUN apk add --no-cache ffmpeg

EXPOSE 3000

# Apply any pending migrations, then start the server. Safe to run on every
# boot: migrate deploy is a no-op when the schema is already up to date.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
