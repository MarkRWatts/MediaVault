# Music section — implementation spec

Working spec for the `music-section` branch. This file is the source of truth
for the build; it is deleted before merge. Read `AGENTS.md` first — this repo
uses a newer Next.js than your training data; consult
`node_modules/next/dist/docs/` for anything App-Router/API related, and mimic
the conventions of the existing movie/TV code rather than inventing new ones.

## Goal

Index the `MUSIC_PATH` folder (iTunes layout: `Artist/Album/NN Track.m4a`) as
a third section beside films and TV: artist pages showing the full studio
back-catalogue from MusicBrainz with owned albums in colour and missing ones
greyed (same philosophy as `owned=false` Films), plus a report section.
A working mock of the target artist-page look exists — decade-grouped square
cover grid, stat tiles, "Also on the shelf" strip — follow the app's existing
design tokens (globals.css) exactly as the collection pages do.

## Facts about the real data (verified against the share)

- ~80 artist folders, ~2,200 tracks. Mostly ALAC 16/44.1 `.m4a` with embedded
  cover art (encoder "Music …"); 43 Bandcamp-style `.mp3`
  (`01-Track_Name.mp3` — dash after number, underscores for spaces); 14 `.m4p`
  (FairPlay DRM — index them, badge them as DRM, they cannot play elsewhere).
- Track filenames: `01 Title.m4a` or `1-01 Title.m4a` (disc-track). Titles may
  legitimately end in digits ("Optigan 1", "We Come 1") — never strip them.
- Album folders may carry suffixes like `[EP]` or `- DVD`; artist folders may
  contain `;`/`_` where iTunes sanitised `/` and `:`.
- Special top-level folders to handle: `Compilations` (various-artists — index
  albums but mark artist `various=true`, skip MusicBrainz artist matching and
  back-catalogue logic), `Automatically Add to Music.localized` and any
  `*.localized` (skip entirely). Skip `.DS_Store`, `._*` AppleDouble files.
- MusicBrainz quirks to respect: rate limit 1 req/s (global limiter, send
  `User-Agent: filmDB/1.3 (https://github.com/MarkRWatts/filmDB)`); bootlegs
  pollute release-group browses, so use the *search* endpoint with
  `status:official`; early Frank Zappa albums are credited to a separate
  artist "The Mothers of Invention" (v1: accept this as a known gap — do NOT
  build artist-merge logic); small-artist gaps exist (e.g. an owned album may
  have no release group at all — keep it, matchConfidence stays UNMATCHED).

## Schema (append to prisma/schema.prisma; migration name `add_music`)

```prisma
// --- Music ---
// Same philosophy as movies/TV: Album rows exist for back-catalogue entries
// we DON'T own (owned=false), created from MusicBrainz release-group listings.

model Artist {
  id              Int      @id @default(autoincrement())
  name            String
  sortName        String
  folder          String   @unique // top-level folder under MUSIC_PATH
  mbid            String?  @unique // MusicBrainz artist id
  disambiguation  String?
  various         Boolean  @default(false) // Compilations pseudo-artist
  matchConfidence String   @default("UNMATCHED") // EXACT | SEARCH | LOW | UNMATCHED
  albums          Album[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([sortName])
}

model Album {
  id          Int       @id @default(autoincrement())
  artistId    Int
  artist      Artist    @relation(fields: [artistId], references: [id], onDelete: Cascade)
  title       String
  sortTitle   String
  year        Int?
  releaseDate DateTime?
  mbid        String?   @unique // MusicBrainz release-group id
  kind        String    @default("STUDIO") // STUDIO | COMPILATION | EP | LIVE | SINGLE | REMIX | SOUNDTRACK | OTHER
  coverPath   String?   // cached cover art file name under the cover cache dir
  owned       Boolean   @default(true)
  folder      String?   // album folder name under the artist folder (null when owned=false)
  trackTotal  Int?      // canonical track count from MusicBrainz, if known
  tracks      Track[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([artistId, folder])
  @@index([artistId])
}

model Track {
  id           Int       @id @default(autoincrement())
  albumId      Int
  album        Album     @relation(fields: [albumId], references: [id], onDelete: Cascade)
  disc         Int       @default(1)
  trackNumber  Int?
  title        String
  filePath     String    @unique // relative to MUSIC_PATH
  fileName     String
  codec        String?   // alac | aac | mp3 | flac | drm | unknown
  lossless     Boolean   @default(false)
  sampleRate   Int?
  bitDepth     Int?
  durationSecs Float?
  sizeBytes    BigInt?
  mtimeMs      Float?    // probe cache key, same convention as Version
  probedAt     DateTime?

  @@index([albumId])
}
```

`ScanRun.kind` gains `ENRICH_MUSIC` (document in the schema header comment).
The existing `SCAN` run also covers music (one scan walks all roots).

## Modules & ownership (one worker per row; do not edit files outside your row)

| Worker | Files | Task |
| --- | --- | --- |
| A (schema+parser) | `prisma/schema.prisma`, migration, `src/lib/parse-music.ts`, `src/lib/constants.ts` (append only), `src/lib/parse-music.test.ts` | Schema above; parser + tests |
| B (enrichment) | `src/lib/musicbrainz.ts`, `src/lib/cover-art.ts`, `src/app/api/enrich-music/route.ts`, `src/app/api/cover/[albumId]/route.ts` | MusicBrainz + cover cache |
| C (scanner+queries) | `src/lib/scanner.ts` (extend), `src/lib/ffprobe.ts` (extend), `src/lib/queries-music.ts` | Scan MUSIC_PATH, probe audio, queries |
| D (UI) | `src/app/music/**`, `src/components/CoverImage.tsx`, `src/components/AudioCodecBadge.tsx`, nav component, `src/app/report/page.tsx` (add one section + tiles) | Pages per mock |
| E (docs) | `README.md`, `.env.example`, `.env.docker.example`, `docker-compose*.yml`, `DEPLOYMENT.md` | `MUSIC_PATH` plumbing |

## Parser (`parse-music.ts`)

Input: path segments `artistFolder / albumFolder / fileName`. Output:
`{ artistName, albumTitle, disc, trackNumber, title, ext }`.
- `NN Title.ext` → disc 1, track NN. `D-NN Title.ext` → disc D, track NN.
- Bandcamp mp3: `NN-Title_With_Underscores.mp3` → underscores→spaces.
- No leading number → trackNumber null, title = basename.
- Album folder: strip nothing by default; expose `albumEditionTag` when the
  folder ends with `[...]` (e.g. `[EP]`) — title keeps reading naturally.
- Never trim trailing digits from titles.
- Extensions: m4a, mp3, m4p, flac, aac. `.m4p` → codec hint `drm`.
- Tests: cover every real-world case listed in Facts above (mirror the style
  of `parse.test.ts` / `parse-tv.test.ts`).

## Enrichment (`musicbrainz.ts`)

Per artist (skip `various`): search `/ws/2/artist?query=artist:"<name>"`,
prefer exact normalized-name match (mimic `pickHit` in `tmdb.ts`; confidence
EXACT/SEARCH/LOW like films). Then release-group search
`arid:<mbid> AND status:official AND (primarytype:album OR primarytype:ep)`,
paginate (limit 100). Classify `kind`: Album w/o secondary → STUDIO; secondary
Compilation → COMPILATION, Live → LIVE, Remix → REMIX, Soundtrack →
SOUNDTRACK; EP → EP; else OTHER. Match owned albums to release groups by
normalized title (lowercase, strip diacritics/punctuation/`[...]` tags —
reuse/extend `normalizeTitle`); attach mbid/year/kind on match. Create
owned=false Album rows ONLY for kind=STUDIO groups not owned. Reconcile like
tmdb.ts does: reclaim placeholders, never merge except on exact match, and
delete owned=false rows whose release group vanished from the listing.
Cover art (`cover-art.ts`): CAA `https://coverartarchive.org/release-group/
<mbid>/front-250` (redirects OK, >5 KB sanity check), fallback iTunes Search
API (`term=<artist> <title>&entity=album`, best title-similarity > 0.5, take
`artworkUrl100` → `300x300`); cache under `POSTER_CACHE_DIR/covers/`,
serve via `/api/cover/[albumId]` mirroring `/api/poster`.

## Scanner

Extend the single SCAN run: if `MUSIC_PATH` set (else skip silently — same
graceful-absence as TVSHOWS_PATH), walk `Artist/Album/files`. Upsert
Artist/Album/Track; probe each file with ffprobe (add MUSIC_PATH to the
multi-root docker fallback in `ffprobe.ts`), extracting codec
(alac/aac/mp3/flac), sample rate, bit depth (`bits_per_raw_sample` — first
audio stream only; files also contain an mjpeg cover stream, ignore it),
duration, size, mtime. `lossless = codec in (alac, flac)`. `.m4p`: do NOT
probe, set codec `drm`, lossless false. Probe cache identical to movies:
skip when size+mtime unchanged. Reconciliation: delete Track rows for
vanished files; Album owned=true iff it has ≥1 Track; delete artists with no
albums at all. NOTE: probing ~2,200 files via docker takes ~30+ min locally —
acceptable (cache makes rescans cheap); native ffprobe in the prod container
is fast.

## Queries (`queries-music.ts`) — contract Worker D codes against

```ts
export async function getMusicIndex(): Promise<{
  totals: { artists: number; albumsOwned: number; tracks: number; losslessPct: number };
  artists: { id: number; name: string; various: boolean; ownedStudio: number;
             totalStudio: number; coverAlbumId: number | null }[]; // sorted by sortName
}>;
export async function getArtistDetail(id: number): Promise<null | {
  artist: { id: number; name: string; disambiguation: string | null; various: boolean };
  studio: { id: number; title: string; year: number | null; owned: boolean;
            hasCover: boolean; trackCount: number; trackTotal: number | null }[]; // release order
  shelf: typeof studio & { kind: string }[]; // owned non-studio, by year
  stats: { owned: number; total: number; pct: number; yearMin: number | null; yearMax: number | null };
}>;
export async function getAlbumDetail(id: number): Promise<null | { /* album + artist +
  tracks grouped by disc, each { trackNumber, title, codec, lossless, durationSecs } */ }>;
export async function getMusicReportData(): Promise<{
  totals: { artists: number; albumsOwned: number; albumsMissing: number; losslessPct: number };
  missingByArtist: { artistId: number; artistName: string;
    albums: { id: number; title: string; year: number | null; hasCover: boolean }[] }[];
}>;
```

Report threshold: an artist appears in `missingByArtist` only when
`ownedStudio >= 2 && ownedStudio / totalStudio >= 0.2` (constants
`MUSIC_REPORT_MIN_OWNED`, `MUSIC_REPORT_MIN_PCT` in constants.ts) — keeps
2-of-43 completist catalogues (Zappa) from drowning the report. The artist
*page* always shows the full catalogue regardless.

## UI (Worker D)

- Nav gains `Music` (after Shows). Hide link when MUSIC_PATH unset? No —
  match how TV handles absence (empty state page).
- RENAME: the existing `Library` section becomes `Movies` — nav label, the
  page's h1/title, and any user-visible "Library" text referring to the films
  grid (do not rename routes/files, just visible copy).
- `/music`: totals strip (like report tiles) + artist grid: square cover of
  the artist's first owned album (by year) via `/api/cover/<coverAlbumId>`,
  name, `owned/total` mono count. `Compilations` artist sorts last.
- `/music/artist/[id]`: the mock's layout in real components: Bebas h1, stat
  tiles (owned n/m, missing, % complete, progress bar), decade-grouped grid
  (`8.6rem` min columns) of studio albums — owned full colour w/ green
  `Owned` chip, missing `grayscale opacity-45 dashed` w/ rose `Missing` chip —
  then "Also on the shelf" strip (kind chips: Compilation/EP/Live/Remix).
  Albums link to `/music/album/[id]`.
- `/music/album/[id]`: cover, title/year/kind, per-disc track table (number,
  title, duration mm:ss, codec badge). `AudioCodecBadge`: ALAC/FLAC use the
  blu-style tokens, MP3/AAC dvd-style, DRM missing-style.
- Report page: add tiles (Artists, Albums `owned/total`, Lossless %) and one
  `CollapsibleSection` "Missing from back catalogues" (`open=music` in the
  `?open=` param scheme), grouped by artist like Missing-from-collections.
- Square covers: new `CoverImage` (aspect-square) modelled on `PosterImage`
  incl. the no-art title-card fallback. All pages `force-dynamic` like others.

## Env & deploy (Worker E)

`MUSIC_PATH` optional everywhere, mirroring `TVSHOWS_PATH` exactly:
`.env.example`, `.env.docker.example`, compose passthrough + prod override
(`MUSIC_PATH: /media-share/Music`), README Configuration table + feature
bullet, DEPLOYMENT note. Do not invent new SMB variables — same share.

## Verification

Each worker: `npx tsc --noEmit`, `npx vitest run`, and `npm run lint` must
pass before reporting done. Do NOT run `git commit` — the session lead
reviews and commits. Integration (lead): scan + enrich against the real
share, spot-check Kebu (5/5 studio complete), Blur (3/9), Zappa (2/43,
threshold hides from report), Compilations (various, no MB calls).
