# filmDB

A personal index of the DVD/Blu-ray film collection stored on the nas.example.lan
SMB share (`//nas.example.lan/media` → `Movies`, also served by Jellyfin). It scans
the share, probes every file with ffprobe for real resolution and soundtracks,
enriches from TMDB, and presents a poster-forward library with collection
timelines and a "what's missing" collector's report.

- **Library** — every owned film, searchable/filterable, with DVD/Blu-ray badges.
- **Film detail** — editions (theatrical vs director's cut), resolutions,
  soundtracks, file details.
- **Collections** — James Bond, Alien, etc., in release-order timelines with
  missing films greyed out.
- **Report** — missing films per collection, Blu-ray upgrade candidates
  (DVD-only titles), and files needing metadata attention.

## Stack

Next.js 15 (App Router) · Prisma 7 + SQLite · Tailwind v4 · ffprobe · TMDB API.
See [PLAN.md](PLAN.md) for design decisions and [DEPLOYMENT.md](DEPLOYMENT.md)
for Docker/VM deployment (shared-Caddy `edge` network pattern).

## Development

```bash
cp .env.example .env       # add TMDB_API_KEY for metadata/posters
npm install
npx prisma migrate dev
npm run dev                # http://localhost:3000
```

The dev scanner needs the share mounted at `/Volumes/media` and OrbStack/Docker
running (ffprobe runs via the `mwader/static-ffmpeg` image when no local
ffprobe exists). Trigger scans from the UI, or:

```bash
curl -X POST localhost:3000/api/scan
curl -X POST localhost:3000/api/enrich
```

## Tests

```bash
npx vitest run
```

The filename parser is tested against the real quirks of the share's naming
(missing years, `[imdbid-…]`/`[tmdbid-…]` tags, edition brackets, underscores,
glued tags, typo'd extensions).
