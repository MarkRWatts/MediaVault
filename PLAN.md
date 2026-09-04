# MediaVault — Plan

A good-looking web app + lightweight database indexing the DVD/BluRay rips in
a NAS SMB share (mounted at `/Volumes/media/Movies` on the Mac;
the deploy VM mounts the same SMB share and the container sees it read-only at
`/movies` via `MOVIES_PATH`).

> **Status (2026-09):** everything below through "Build order" is the
> original film-only plan, kept as the record of the founding decisions. The
> app has since grown TV shows, a Discogs-backed music library with physical
> pressings, an opt-in Adult media type, barcode scanning, in-browser video
> and gapless audio playback, households with email-code and passkey sign-in,
> Jellyfin SSO, and per-member watch history — see README.md for the current
> feature list, `HOUSEHOLDS_PLAN.md` and `PASSKEYS_PLAN.md` for those
> rollouts. The two "Future" sections at the end are updated to what
> actually shipped, and **"Roadmap"** below them is the current list of
> what's worth building next.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind) — same family as jobAppTracker.
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
  `edge` network with alias `mediavault`; shared Caddy on the VM proxies to it).
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

## Playback (decided 2026-08 — built, with one reversal)

- **Music, gapless, in-browser — built** as planned (`AlbumPlayer.tsx`,
  `/api/audio/[trackId]`, `src/lib/audio-stream.ts`): Web Audio API with
  prefetched decoded buffers and sample-accurate scheduling. Safari decodes
  ALAC natively; other browsers get a server-side ALAC→FLAC remux, which is
  lossless-to-lossless (bit-identical PCM), not a quality-losing transcode.
  Shuffle and repeat-album exist; there is no cross-album queue and no
  listening history (see Roadmap).
- **Video — the "stays external" decision was reversed.** In-browser film
  playback shipped (`VideoPlayer.tsx`, `/api/video/[versionId]/*`,
  `src/lib/video-cache.ts`): a file that's already browser-playable is served
  as-is with byte-range support; anything else is remuxed or transcoded by
  ffmpeg into a cached fragmented MP4 and **streamed while it's still being
  written** (`tailing-stream.ts`), so there's no encode-then-wait step. The
  original objection (this library never transcodes) was traded for
  convenience: DTS/TrueHD/PCM audio is transcoded to AAC only when no
  AAC/AC-3/E-AC-3 track exists, and video is re-encoded only for MPEG-2/VC-1
  DVD-era sources. Apple TV keeps the Infuse-via-Jellyfin direct-play path.
  The same pipeline plays Adult scenes. **TV episodes never got a player** —
  they still only deep-link to Jellyfin (see Roadmap, first item). The "Open
  in IINA/VLC" desktop links were never built either.

## Households, per-user watch history & stats — shipped (see HOUSEHOLDS_PLAN.md)

All nine phases of `HOUSEHOLDS_PLAN.md` are live, plus the post-deploy
additions (app-owner role, unified `/account`, `/admin`, Jellyfin SSO) and
`PASSKEYS_PLAN.md`'s passkey sign-in. The one schema addition tracked here
alongside the rest of the data model is `WatchProgress`, for per-user resume
position and stats. `Film`/`Version` and TV `Episode`/`EpisodeFile` don't
share an id space, so exactly one of `versionId`/`episodeFileId` is set per
row (app-level invariant, same as SQLite's general lack of CHECK-constraint
support elsewhere in this schema). Only the `versionId` half is wired today —
`episodeFileId` waits on TV playback:

```prisma
model WatchProgress {
  id            Int       @id @default(autoincrement())
  userId        String    // BetterAuth User.id
  versionId     Int?
  version       Version?     @relation(fields: [versionId], references: [id], onDelete: Cascade)
  episodeFileId Int?
  episodeFile   EpisodeFile? @relation(fields: [episodeFileId], references: [id], onDelete: Cascade)
  positionSecs  Float
  completed     Boolean   @default(false)
  playCount     Int       @default(0)
  updatedAt     DateTime  @updatedAt

  @@unique([userId, versionId])
  @@unique([userId, episodeFileId])
  @@index([userId])
}
```

## Roadmap (2026-09)

From a review of the codebase against the plan documents (what's built, what
the schema and enrichment already carry but nothing renders, what the plans
themselves deferred). Effort is rough, in focused days, at the pace the
households and passkeys rollouts actually went. Grouped by how much of the
work already exists.

**Recommended order: TV playback → global search → scan log on `/report`.**
They're independent, each is under a week, and together they close the three
gaps a household member hits first.

### Finish what's half-built

| Item | Why now | Already exists | Est. |
|---|---|---|---|
| **TV episode playback + progress** | Shows are the only media type with no in-app play; episodes only deep-link to Jellyfin | The remux/transcode + tailing-stream pipeline, `VideoPlayer`, and `WatchProgress.episodeFileId` (unwired). Needs an `/api/episode/[fileId]/*` twin of the film routes, a Play button on `EpisodeRow`, and "Continue watching" for shows | 2–3 |
| **Scan log + unmatched files on `/report`** | `ScanRun.log`/`filesSeen` record every unparseable filename and probe failure and *nothing renders them* — the report can't see the files that never became rows, which PLAN.md promised it would | The data, `GET /api/runs`; `ScanControls`' `RunInfo` just omits the fields | 1 |
| **Film "fix this match" form** | Albums have one; films flagged LOW/UNMATCHED on `/report` can only be corrected by rescanning | `FixAlbumMatchForm` as the pattern, `search-movie` route | 1 |
| **Blu-ray → 4K upgrade candidates** | The upgrade list only covers DVD → Blu-ray though UHD is a first-class format everywhere else | `getReportData`'s upgrade query, one more predicate | 0.25 |
| **Music listening history** | `AlbumPlayer` reports nothing; `/stats` is films-only | The `WatchProgress` pattern and the throttled reporting in `VideoPlayer` port directly | 1.5 |
| **Render what enrichment already stores** | Scene backdrops, performer images, episode overviews + air dates, album release dates are fetched and never shown | All in the schema and selected in queries; `Performer.imagePath` is even passed to the page | 1 |
| **Invitation emails** | Household invites are still copy-a-link | Resend is wired for OTP and access codes; `sendInvitationEmail` is the one plugin hook not configured | 0.5 |

### New for the household

| Item | Why | Already exists | Est. |
|---|---|---|---|
| **Global search** | Only Movies has search, client-side over one list. One box across films, shows, artists, albums, collections is the most-used feature the app doesn't have | Per-model queries; needs a server-side search query + `/search` page + nav box | 2 |
| **A personal layer: watchlist, favourites, rating** | Households exist, but the only per-person state is watch history and the adult opt-in | `WatchProgress`'s per-user shape; `Film.rating` is TMDB's, read-only | 3 |
| **A real wantlist** | "Missing" is machine-derived from TMDB/Discogs; no way to add an arbitrary title or mark one ordered / won't-own, so `/report` never stops listing it | The `owned=false` rows; needs a state column and an add-by-search form | 2 |
| **Physical-media logistics** | Location/shelf, lent-to, purchase date + price. Pressing tracking is thorough but can't answer "where is it" or "who has it" | `PhysicalCopy` / `FilmPhysicalCopy` + their edit forms | 1.5 |
| **Jellyfin watch-state sync** | The two watch histories are entirely separate; "Continue watching" is wrong for people who watch on the TV | `User.jellyfinUserId`, `Version.jellyfinId`, the Jellyfin client in `src/lib/jellyfin.ts` | 2 |
| **"Open in IINA/VLC" links** | Direct play on desktop with no transcode; in the original plan, never built | `/api/video/[versionId]/stream` already serves byte ranges for direct-play files | 0.5 |

### Platform and operations

| Item | Why | Already exists | Est. |
|---|---|---|---|
| **Native-client API** | MediaVaultTV can only read `/api/films` and has no auth path but a scraped browser cookie. PASSKEYS_PLAN.md defers tvOS passkeys, so this is the realistic route | BetterAuth ships a device-authorization plugin; the film routes are the shape to copy for shows, episodes, and music | 3–4 |
| **Scheduled scans + weekly digest** | Scans are manual; the app sends no email beyond auth | `ScanRun`/`runs.ts` guard, Resend, `getLibraryFilms`' "recently added" | 2 |
| **Audit log search, paging, retention** | One consumer reads the last 100 rows with no filter, and nothing prunes | `AuditLog` + `/admin` | 1 |

### Housekeeping (fold into whichever lands first, ~0.5 day)

- `src/lib/email.ts` header still says it's "not yet wired into anything".
- Five files cite `ADULT_PLAN.md`, which is local-only and not in the repo.
- README says TheAudioDB/Fanart.tv work; `.env.example` and `DEPLOYMENT.md`
  say unused; the code path is unreachable since the Discogs cutover
  (`fetchArtistEnrichment` is always called with `mbid: null`). Pick one.
- `prisma/schema.prisma`'s `ScanRun.kind` comment lists four kinds; the
  source of truth it points at (`src/lib/runs.ts`) has eight.
- `AuditLog` has no pruning job.

**Totals:** finish-half-built ≈ 7–8 days · new-for-the-household ≈ 11 days ·
platform ≈ 6–7 days. The recommended first three ≈ 5–6 days.
