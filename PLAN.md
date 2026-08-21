# filmDB — Plan

A good-looking web app + lightweight database indexing the DVD/BluRay rips in
a NAS SMB share (mounted at `/Volumes/media/Movies` on the Mac;
the deploy VM mounts the same SMB share and the container sees it read-only at
`/movies` via `MOVIES_PATH`).

## Stack

- **Next.js 15** (App Router, TypeScript, Tailwind) — same family as jobAppTracker.
- **SQLite + Prisma** — "lightweight database"; single file in a Docker volume,
  `prisma migrate deploy` at boot exactly like jobAppTracker. No db container.
- **ffprobe** (from the `ffmpeg` apk package in the runtime image) for ground
  truth: width/height, audio streams (multiple soundtracks), duration, size.
  Local dev without ffprobe on PATH falls back to
  `docker run --entrypoint /ffprobe mwader/static-ffmpeg` (verified working
  against the share).
- **TMDB API** (free key, `TMDB_API_KEY` env) for enrichment: posters, overview,
  release dates, and crucially `belongs_to_collection` → the canonical list of
  films in each collection, which is what powers "missing film" detection.
  Posters are cached to a local volume so the app is self-contained after
  enrichment. The app degrades gracefully with no key (scan-only data).

## Data model

- `Film` — one movie identity. `title`, `year`, `imdbId?`, `tmdbId?`, enrichment
  fields (overview, posterPath, releaseDate, runtime, rating), `collectionId?`,
  `owned` flag. **Missing films are rows too** (`owned=false`), created from
  TMDB collection parts we don't have on disk.
- `Version` — one file on disk, belongs to a Film. `filePath`, `edition?`
  ("Theatrical Release", "2003 Directors Cut", "Extended Edition"…), `width`,
  `height`, `format` (**BLURAY** if height ≥ 720, **DVD** if ≤ 576, else SD/HD
  judgement), `sizeBytes`, `durationSecs`, `videoCodec`, `container`.
- `AudioTrack` — per Version: codec, language, channels, title ("Surround 5.1").
- `Collection` — TMDB collection: name, posterPath, overview. Films ordered by
  release date = timeline order.
- `ScanRun` — bookkeeping: started/finished, files seen, unmatched names.

Identity/merge rule: group files into one Film by `imdbId` when present, else
normalised `title+year` (Alien theatrical + director's cut = 1 film, 2 versions;
a DVD and a BluRay rip of the same film = 1 film, 2 versions).

## Scanner (server-side, triggered from UI + on first boot)

1. Walk `MOVIES_PATH` (depth ≤ 3 — handles loose files, collection folders, and
   Indiana-Jones-style film folders inside collection folders).
2. Parse Jellyfin-style names, tolerant of the real mess observed:
   `Name (Year)`, `[imdbid-ttXXX]`, `[tmdbid-XXX]`, `[1080p]`/`[720p]`,
   edition tags (`[Extended Edition]`, `[2003 Directors Cut]`, `(Special Edition)`),
   stray ` - ` before tags, underscores (`The_A-Team`), missing years
   (`Serenity.mkv`), typos (`(2003)mkv.mkv`).
3. ffprobe each file (cache by path+mtime+size so rescans are cheap).
4. Upsert Films/Versions/AudioTracks; report unparseable/unmatched files.

## Enrichment (needs TMDB_API_KEY)

1. Match: `imdbid` → TMDB `/find`, else search by title+year, else title only
   (flag low-confidence matches in the report).
2. Pull details + `belongs_to_collection`; fetch each collection's parts and
   create `owned=false` Films for the ones not on disk (skip unreleased).
3. Download + cache posters/backdrops to `POSTER_CACHE_DIR` volume.

## UI (dark, poster-forward, "good looking" is a requirement)

- `/` — poster grid of owned films; search; filters (format, resolution,
  collection, decade); sort (title/year/added).
- `/film/[id]` — backdrop hero, poster, overview; versions table (DVD/BluRay
  badges, resolution, size, codec); soundtracks per version.
- `/collections` — cards with poster collage + completion ("7/9 · 2 missing").
- `/collections/[id]` — timeline in release order; owned films full colour,
  missing films greyed out with a "missing" treatment.
- `/report` — the collecting dashboard: per-collection missing films, films
  owned only on DVD (BluRay upgrade candidates), unmatched/unparsed files,
  low-confidence TMDB matches.
- Scan/enrich buttons with progress, in a small admin strip.

## Deployment (mirrors jobAppTracker exactly)

- Multi-stage `node:22-alpine` Dockerfile (+ `apk add ffmpeg` in runner),
  `prisma migrate deploy && npm start` at boot.
- `docker-compose.yml` (base) + `docker-compose.override.yml` (local port
  3002 — 3000/3001 are taken) + `docker-compose.prod.yml` (joins external
  `edge` network with alias `filmdb`; shared Caddy on the VM proxies to it).
- Volumes: `data` (SQLite + poster cache); bind-mount of the SMB share →
  `/movies:ro` (`MOVIES_HOST_PATH` env: `/Volumes/media/Movies` locally, the
  VM's mount point in prod).

## Build order

1. Scaffold (create-next-app), Prisma schema, migration — main session.
2. Filename parser + unit tests against the real corpus — main session (the
   fiddly correctness core).
3. Scanner + ffprobe + TMDB enrichment lib — delegated to a Sonnet agent.
4. UI pages — delegated to a Sonnet agent (with the design skill).
5. Dockerfile/compose — delegated to a Haiku agent from the jobAppTracker
   reference.
6. Integrate, migrate, full scan of the real share, verify in browser — main
   session.

## Future: playback (decided 2026-08, not yet built)

- **Music, gapless, in-browser** — planned as a phase after the music
  section merges. Web Audio API with prefetched decoded buffers and
  sample-accurate scheduling (true gapless; ALAC is lossless so track
  boundaries are exact). Safari decodes ALAC natively; other browsers get a
  server-side ALAC→FLAC/WAV conversion, which is lossless-to-lossless (bit-
  identical PCM), not a quality-losing transcode.
- **Video stays external** — deliberately NO in-browser video player. The
  library is MKV + DTS/DTS-HD MA/AC3; browsers demux none of that container
  and decode none of those audio codecs, so browser playback would force
  audio transcoding (rejected: this library never transcodes). Apple TV
  keeps the Infuse-via-Jellyfin direct-play path. Optional later addition:
  a raw HTTP range-streaming endpoint plus "Open in IINA/VLC" links for
  desktop — direct playback without Jellyfin and without transcoding.
