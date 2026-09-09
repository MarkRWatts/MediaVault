# MediaVault — Favourites, playlists, right rail and persistent playback

Drafted 2026-09-09. **Status:** PR1 (engine + right rail) merged as #70; PR2 (favourites) on `claude/music-favourites`; PR3 (playlists) to follow.

## Context

Music playback today is one gapless Web Audio engine living inside
`src/components/AlbumPlayer.tsx`, mounted per album page. Navigating away
unmounts it and closes the AudioContext, so you cannot browse while
listening, and there is no queue beyond one album. Films and shows already
have per-user favourites (`FilmFavourite` / `ShowFavourite`, `CardActions`,
`FilmActions`); music has nothing personal at all. PLAN.md's roadmap lists
"a personal layer" and "no cross-album queue" as known gaps.

Decisions agreed with the user (2026-09-09):

- **Right-hand rail**, mirroring the floating left sidebar, holds the
  persistent player (Now Playing card at the top), the queue, and the
  playlists list. Collapsible; a strip + sheet on mobile.
- **Favourites** for tracks, albums, artists, **per user** (same shape as
  film/show favourites). Favourite tracks also act as a pinned, built-in,
  non-editable "Favourite tracks" list in the rail.
- **Playlists are per person.**
- Three PRs, opened sequentially after each merges (never stacked — see the
  stacked-PRs memory).

Verified facts that shape the design:

- Next 16 docs: layouts preserve client state across navigation, and
  `router.refresh()` re-renders Server Components without losing client
  state (`node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`,
  `use-router.md`). A `"use client"` provider mounted in `AppShell` keeps
  the engine alive.
- `src/lib/scanner.ts:474-545` upserts `Track` by `filePath` (`@unique`)
  and only deletes rows whose file vanished, so track ids are stable across
  rescans and `onDelete: Cascade` is the right behaviour for favourites and
  playlist items.
- `<main>` is `@container`; the card-grid ladders in `src/lib/card-grid.ts`
  measure the container's content box, so extra right padding for the rail
  reflows grids with no change.
- `src/lib/route-guards.test.ts` requires every new `page.tsx` to contain
  `requireMemberOrRedirect(` and every `route.ts` `requireMemberOrResponse(`.
- `src/components/SectionHeader.tsx` hard-codes "film(s)"; needs a `noun` prop.
- `deleteAccount` in `src/app/actions/account.ts:105` is a bare
  `prisma.user.delete`; FK-less per-user rows are orphaned. Add
  `deleteMany` for the new tables (and the existing three) when we touch it.

---

## PR1 — Global engine + right rail (Now Playing + queue)

### Engine extraction

| File | Role |
|---|---|
| `src/lib/player-types.ts` | `QueueTrack`, `QueueEntry`, `PlayerStatus`, `PlaybackContext`, `PlayerSnapshot`, `EMPTY_SNAPSHOT`. Importable from server code. |
| `src/lib/player-engine.ts` | Framework-free `PlayerEngine` class. Carries AlbumPlayer's header comment (updated). Deps injected: `createContext`, `loadBuffer` — so it is unit-testable with a fake AudioContext. |
| `src/lib/format-time.ts` | `formatTime` moved out of AlbumPlayer; `AlbumFormatTabs.formatDuration` aliases it. |
| `src/components/player/PlayerProvider.tsx` | `"use client"`. Lazily creates one engine on `globalThis` (survives Fast Refresh / remounts), exposes it via context with `useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => EMPTY_SNAPSHOT)`. Sets `navigator.mediaSession` metadata + handlers. |
| `src/components/player/usePlayer.ts` | `usePlayer() → { snapshot, engine }`. |
| `src/components/player/icons.tsx` | The SVG glyphs relocated from AlbumPlayer. |
| `src/components/player/TrackMenu.tsx` | "…" popover: Play, Play next, Add to queue (PR3 adds Add to playlist ▸). `role="menu"`, outside-click/Escape close, no deps. |
| `src/components/AlbumPlayBar.tsx` | Replaces AlbumPlayer on the album page: Play album, Shuffle, Play next, Add to queue. Calls `engine.playTracks` etc. |
| `src/components/AlbumPlayer.tsx` | **Deleted.** Update the references in `PLAN.md` (Playback section, roadmap) and `README.md:36`. |

Types:

```ts
interface QueueTrack { trackId; title; artist; albumId; albumTitle; hasCover; coverVersion; durationSecs; codec }
interface QueueEntry extends QueueTrack { key: number }   // engine-assigned, unique per enqueue
type PlaybackContext = {kind:"album",albumId,title} | {kind:"playlist",playlistId,title} | {kind:"favourites"} | {kind:"queue"}
interface PlayerSnapshot { status; queue: QueueEntry[]; order: number[]; currentKey; current; duration; shuffle; repeat; volume; context }
```

Everything AlbumPlayer keyed by "real track index" (`buffersRef`, `sourcesRef`,
`scheduleRef`, `pendingRef`, `playOrderRef`, `currentIndexRef`) is keyed by
`QueueEntry.key` instead (positions shift on edits; trackIds can repeat in a
queue). Keys start at 1 so `NO_PREDECESSOR = -1` still cannot collide.

Engine API: `subscribe/getSnapshot`; `playTracks(tracks, {startIndex?, shuffle?, context?})`,
`playNext`, `addToQueue`, `removeFromQueue(key)`, `moveInQueue(key, toOrderIndex)`,
`clearQueue`, `jumpTo(key)`; `play/pause/toggle/next/previous/seek(secs)`;
`setShuffle/setRepeat/setVolume`; `getPosition()` (polled by rAF in the UI, as
today — no per-frame re-render).

What moves verbatim (key substitution only): `ensureAudioContext` + gain,
`scheduleAt` (incl. the playback-paced prefetch gate), `prefetch` (FLAC then
`?fmt=wav`; add one `Retry-After` retry on 503 before falling back), `maybeChain`,
`handleTrackEnded`, `onAlbumEnded → onQueueEnded`, `startFrom`, `stopAllSources`,
`releaseBuffersExcept`, the `session` counter. The unmount `ctx.close()` goes
away (one AudioContext for the page lifetime). `play()` also resumes from
Safari's `"interrupted"` state.

Queue edits keep the "only current + next are ever decoded" invariant via one
helper, `rechainAfterCurrent({keepBuffers})`: stop every source except
current's, drop their schedule entries (and buffers unless kept), then
`prefetch(nextKey(current))` if playing/loading. A `wanted(key)` guard on
prefetch resolve discards buffers that are no longer current/next.

- `playNext`: splice after current in `queue` and `order`; rechain, drop buffers.
- `addToQueue`: append; rechain keeping buffers (only matters when current was last).
- `removeFromQueue(current)` behaves as `next()`; otherwise splice + rechain if it was next.
- `moveInQueue`, `setShuffle` (`[current, ...shuffled(rest)]`): rechain, drop buffers.
  This also removes the documented "old order may still play" quirk.
- `seek(secs)`: only when current's buffer is decoded; new source
  `start(now+ε, secs)`, anchor `startAt = now+ε−secs` so chain arithmetic is
  unchanged; rechain keeping buffers. Pause stays `ctx.suspend()`.

Album page as thin client: `src/app/music/album/[id]/page.tsx` builds
`queueTracks: QueueTrack[]` (artist name, album fields attached; DRM filtered
as today). `AlbumFormatTabs` renders `<AlbumPlayBar>` where `<AlbumPlayer>`
was, and `DigitalTracklist` rows get a hover/focus play button, a
now-playing highlight (`snapshot.current?.trackId === t.id`) and `<TrackMenu>`.

### Right rail

Files: `src/components/shell/rail.tsx` (client `<aside>`), `now-playing-card.tsx`,
`queue-panel.tsx`, `mobile-player-bar.tsx`. Template: `sidebar.tsx`.

- Markup mirrors the sidebar: `id="app-rail"`, `data-collapsed`, same glass
  classes, `right-[max(1rem,env(safe-area-inset-right))]`, `z-30`, `md:flex`.
- `globals.css`, beside the sidebar block:
  `:root{--rail-w:0rem}`, `body:has(#app-rail){--rail-w:4.5rem}`,
  `@media (min-width:1280px){ body:has(#app-rail[data-collapsed="false"]){--rail-w:20rem} }`.
  Expanded only from `xl` (at `lg` a 16rem sidebar + 20rem rail leaves ~450px).
  Row variants use `xl:group-data-[collapsed=false]:`.
- `<main>` in `app-shell.tsx`: add `md:pr-[calc(var(--rail-w)+1rem+max(1rem,env(safe-area-inset-right)))]`,
  `transition-[padding-left]` → `transition-[padding]`.
- Visibility: render when `snapshot.queue.length > 0 || playlists.length > 0 || pathname.startsWith("/music")`.
  All SSR-safe (queue always empty at hydration). No rail in DOM → `--rail-w` stays 0.
- Collapsed strip: toggle (`PanelRightOpen/Close`), 40px cover (click → expand),
  play/pause, `ListMusic` with queue-count badge. Expanded: toggle, Now Playing
  card (cover, title, artist·album links, shuffle/prev/play/next/repeat,
  click-to-seek progress bar, volume), Queue (from current onward: cover 32px,
  title, artist, duration, remove, up/down, click → `jumpTo`), then PR3's
  playlists. Column is `overflow-y-auto`.
- Persist `User.railCollapsed Boolean @default(false)` (migration `rail_collapsed`),
  `setRailCollapsed` in `src/app/actions/prefs.ts`, read in AppShell's select.
  **Restart `next dev` after `prisma migrate dev`.**
- Mobile (<md): `mobile-player-bar.tsx` renders only when `snapshot.current`:
  strip `fixed inset-x-3 z-40 md:hidden` just above BottomTabs (cover,
  title/artist, play/pause, next), `id="app-player-bar"`; tap → full-screen
  sheet `z-50` with cover, transport, queue (+ PR3 playlists). `<main>`'s
  `pb-28` → `pb-[calc(7rem+var(--player-bar-h))]` with
  `:root{--player-bar-h:0rem}` and `@media (max-width:47.99rem){ body:has(#app-player-bar){--player-bar-h:4rem} }`.
  VideoPlayer stays `z-[60]` and covers everything.
- AppShell wraps the chrome branch in `<PlayerProvider>`; chromeless/no-session
  branches are untouched, so `/signin`, `/onboarding`, `/consent` stay bare.

### Tests / verification (PR1)

- `src/lib/player-engine.test.ts` with a `FakeAudioContext` (settable
  `currentTime`, `createGain`, `createBufferSource` → `{start(when,offset),stop,disconnect,onended,buffer}`,
  `suspend/resume/state`) and a fake `loadBuffer` returning `{duration}`:
  anchor chaining `startAt = prev.startAt + prev.duration`; only current+next
  loaded; failed load leaves passthrough anchor and advances; `playNext`
  re-chains and drops the stale successor; `addToQueue` on last track
  prefetches; `removeFromQueue(current)` advances; `setShuffle` keeps current
  first; repeat wraps; `seek` anchor maths; `wanted()` discards late resolves;
  snapshot reference stable between mutations.
- `npm run typecheck && npm run lint && npm test` from inside the worktree.
- Browser (dev server via `.claude/launch.json`): play an album → navigate to
  `/`, `/shows`, another album: audio continues, rail follows; queue two albums
  via Play next / Add to queue and confirm the join is gapless; pause/resume;
  seek; shuffle mid-play; collapse persists across reload; `md`/`lg`/`xl`
  with sidebar collapsed/expanded, grids re-ladder; mobile strip above tabs,
  sheet opens, VideoPlayer covers it; `/signin`, `/onboarding`, `/consent`
  have no rail. Screenshot each state.

---

## PR2 — Favourites (tracks, albums, artists)

Schema (migration `music_favourites`), mirroring `FilmFavourite`:

```prisma
model TrackFavourite  { userId String; trackId Int;  track  Track  @relation(..., onDelete: Cascade); createdAt DateTime @default(now()); @@id([userId, trackId]);  @@index([userId]) }
model AlbumFavourite  { userId String; albumId Int;  album  Album  @relation(..., onDelete: Cascade); createdAt DateTime @default(now()); @@id([userId, albumId]);  @@index([userId]) }
model ArtistFavourite { userId String; artistId Int; artist Artist @relation(..., onDelete: Cascade); createdAt DateTime @default(now()); @@id([userId, artistId]); @@index([userId]) }
```
plus `favourites` back-relations on Track/Album/Artist.

- `src/app/actions/music-state.ts` (`"use server"`, pattern of `film-state.ts`
  but via `requireMember()` from `src/lib/require-member.ts`):
  `toggleTrackFavourite`, `toggleAlbumFavourite`, `toggleArtistFavourite` →
  `{favourite}`; `revalidatePath` on `/music`, the entity page,
  `/music/favourites`, and `revalidatePath("/", "layout")` for the rail count.
- `src/lib/music-user-state.ts` (mirrors `film-user-state.ts`):
  `getArtistUserState(userId, artistId, albumIds)`, `getAlbumUserState(userId, albumId, trackIds)`.
- `src/lib/queries-music.ts`: `getMusicFavourites(userId)` (artists as
  `MusicIndexArtist[]`, albums as `FavouriteAlbumView[]`, `trackCount`),
  `getFavouriteTracks(userId)` → `QueueTrack[]` newest first, explicit
  `select` (never `sizeBytes` — BigInt).
- UI: `ArtistActions.tsx` (heart beside the artist `<h1>`), `AlbumActions.tsx`
  (heart in the album `meta` block next to year/kind chips), `TrackHeart.tsx`
  in `DigitalTracklist` rows (optimistic toggle + `router.refresh()`, as
  `CardActions`). `/music`: above the artist grid, `CollapsibleSection`s
  "Favourite artists" and "Favourite albums" (shelves reusing the existing
  card markup) and a "Favourite tracks · N" tile linking to `/music/favourites`
  with a Play button. Add `noun?: string` to `SectionHeader` and `CollapsibleSection`.
- `/music/favourites` page (`force-dynamic`, `requireMemberOrRedirect`):
  header with count · duration, Play, Shuffle; rows with cover thumb, title,
  artist · album links, duration, heart, `TrackMenu`. Separate page rather
  than overloading `/music/playlist/[id]`.
- Rail: pinned "Favourite tracks" row (count) linking to the page with an
  inline play button. AppShell passes `favouriteTrackCount`. A server action
  `loadPlaylistQueue("favourites")` returns `QueueTrack[]` so the rail can
  play without navigating (no new route → no guard-test entry).
- `deleteAccount`: `deleteMany` for the new tables + the existing three.

Tests: `src/app/actions/music-state.test.ts` (temp DB via
`src/lib/test-temp-db.ts`, `vi.mock` of `@/lib/auth` and `next/headers` as in
`src/lib/require-member.test.ts`: toggle on/off, unknown id throws, signed-out
throws); `src/lib/queries-music.test.ts` (ordering, DRM excluded from
favourite tracks, cascade on Track delete). Browser: hearts toggle
optimistically and survive reload; `/music` sections + collapse state;
`/music/favourites` Play/Shuffle feeds the rail; rail count updates.

---

## PR3 — Playlists

Schema (migration `playlists`):

```prisma
model Playlist     { id Int @id @default(autoincrement()); userId String; name String; createdAt; updatedAt; items PlaylistItem[]; @@index([userId]) }
model PlaylistItem { id Int @id @default(autoincrement()); playlistId Int (Cascade); trackId Int (Cascade); position Int; addedAt DateTime @default(now()); @@index([playlistId, position]); @@index([trackId]) }
```
No `@@unique([playlistId, position])`: SQLite checks uniqueness per
statement, so swaps would trip it mid-transaction. Positions are kept dense
0..n-1 by always renumbering inside `prisma.$transaction([...updates])`.

- Actions in `music-state.ts`: `createPlaylist(name) → {id}`, `renamePlaylist`,
  `deletePlaylist`, `addTracksToPlaylist(playlistId, trackIds[]) → {added, skipped}`
  (skips duplicates, DRM, unowned albums; ≤500 ids), `removePlaylistItem`,
  `movePlaylistItem(playlistId, itemId, toPosition)`, and `loadPlaylistQueue(id | "favourites")`.
  Ownership via a private `ownedPlaylist(userId, id)` that throws
  "Playlist not found" for missing and not-yours alike. Names trimmed, 1–80 chars.
- `src/lib/queries-playlists.ts`: `getUserPlaylists(userId)` (`id, name,
  trackCount, coverAlbumId, coverVersion` from first item), `getPlaylistDetail(userId, id)`
  (`items: (QueueTrack & {itemId, position})[]`, `totalSecs`).
- AppShell fetches `getUserPlaylists` and passes to the rail (one more cheap
  query per request; mutations `router.refresh()`). Rail gets
  `playlists-panel.tsx`: pinned Favourite tracks, then playlists (cover, name,
  count, inline play), "New playlist" inline input → `createPlaylist` →
  `router.push("/music/playlist/<id>")`. A small `PlaylistsContext` from the
  rail lets `TrackMenu`'s "Add to playlist ▸" submenu (with "New playlist…")
  and `AlbumActions`' "Add album to playlist" see the list anywhere.
- `/music/playlist/[id]` page (`force-dynamic`, `requireMemberOrRedirect`,
  `notFound()` on null) rendering client `PlaylistView`: inline rename
  (Enter/blur save, Escape cancel), count · duration, Play, Shuffle, Delete
  (confirm modelled on `DeleteAlbumButton.tsx`, then `router.push("/music")`);
  rows with index, cover, title, artist · album, duration, `TrackMenu`,
  Remove, Move up/down buttons (optimistic via `useOptimistic`, revert on
  failure). No drag-and-drop library.
- Mobile sheet gains the playlists panel. `deleteAccount` cleanup for Playlist.

Tests: actions (another user's playlist is "not found"; name validation;
append keeps dense positions and skips duplicates/DRM; move renumbers for
up/down/ends; remove closes the gap; Track delete cascades the item;
Playlist delete cascades items); queries (cover pick, counts, ordering).
Browser: create from rail → detail page; rename; add track/album from menus;
reorder with buttons and keyboard; remove; Play/Shuffle from rail row and
page; delete with confirm; rail refreshes after each mutation while audio
keeps playing.

---

## Risks

- **Autoplay policy:** the AudioContext is created/resumed only inside
  `startFrom`/`play`, reached from a click or from `onended` of a running
  context. Never auto-start on load.
- **Memory:** unchanged — at most current + next decoded; `wanted()` stops
  queue edits leaking a third buffer.
- **Hydration:** rail visibility and the store's server snapshot derive from
  an always-empty initial queue; never read engine state or localStorage in
  render for anything else.
- **Playlist items vanish on file rename/move** (delete + create under a new
  id). Documented; scanner rename-detection is a possible follow-up.
- **e2e scripts:** `scripts/e2e-passkey.ts` and `scripts/e2e-playback.ts`
  are unaffected. `route-guards.test.ts` will flag any new page/route that
  forgets its guard.

## Docs to update

`PLAN.md` Playback section (queue now exists; AlbumPlayer → player-engine),
roadmap "personal layer" row; `README.md` music paragraph; `SIDEBAR_PLAN.md`
gains a "Right rail" note pointing at this plan (copy this file into the repo
as `PLAYLISTS_PLAN.md` in PR1, matching the existing `*_PLAN.md` convention).
