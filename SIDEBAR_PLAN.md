# MediaVault — Left-nav plan

Move MediaVault from its sticky top bar to the floating, collapsible left
sidebar used by Jingle Jotter, TrainTracker and template-app, so all three
apps share one shell. Drafted 2026-09-09. **Status:** PR 1 (shell swap)
merged as #68 the same day, with decision 1 resolved as "retire
UserMenu"; PR 2 (library grids on container queries against `<main>`)
built on `claude/grid-container-queries` — it also converted the
collections, music, adult, report and stats ladders, not just
`CARD_COLUMNS`, since the rail squeezes them all the same way.

This reverses the "deliberately not adopted from the template" note in
`HOUSEHOLDS_PLAN.md` — update that paragraph when this ships.

## Source of truth

Copy from **template-app** (`/Users/mark/claude-code/template-app/components/shell/`),
not from Jingle Jotter directly. Lineage: Jingle Jotter invented the shell
(commit `65d16a3`, 2026-08-26, designed in its `SIDEBAR_PLAN.md`);
template-app is the de-branded extraction two days later; TrainTracker was
seeded from template-app on 2026-09-07. All three carry the same five files:

| File | Role |
|---|---|
| `app-shell.tsx` | Async server component. Decides whether to render chrome at all, reads the user once, renders TopNav + Sidebar + `<main>` + BottomTabs |
| `sidebar.tsx` | Client. Fixed floating glass rail at `md+`; forced to a 4.5rem icon rail between `md` and `lg`; user's collapsed/expanded preference applies at `lg+` |
| `top-nav.tsx` | Server. Mobile-only (`md:hidden`) sticky bar: brand + avatar |
| `bottom-tabs.tsx` | Client. Mobile-only floating tab bar with a "More" sheet for overflow + Account |
| `nav-items.ts` | The one list of destinations, `isNavItemActive()`, and the mobile tab split |

Two refinements to take from **TrainTracker** over template-app:

1. Safe-area insets: rail at `left-[max(1rem,env(safe-area-inset-left))]`
   and `<main>` padded `md:pl-[calc(var(--sidebar-w)+1rem+max(1rem,env(safe-area-inset-left)))]`.
2. The `MORE_ITEMS.length === 0` fallback that gives Account its own tab
   slot (we will always have overflow, but keep the branch so the file
   stays diffable against the siblings).

One pattern to take from **Jingle Jotter**: a separate owner-only row group
(`OWNER_ITEMS` + `ownerRowClass()`), rendered only when `isAppOwner`.
MediaVault needs it for Scan, Report and Admin.

The mechanism worth copying verbatim is in `globals.css`: `--sidebar-w`
is derived from the sidebar's own DOM state with `body:has(#app-sidebar[data-collapsed])`,
so `<main>` reflows with no client JS and no hydration flash. Collapse
state is persisted as a `User.sidebarCollapsed` column via a server
action, read server-side in `AppShell` so the first paint is already the
right width.

## What MediaVault has today

- `src/app/layout.tsx` is the only layout. It reads an `x-pathname` header
  set by `src/proxy.ts` and hides `<Nav />` when `isPreAuthPath()` matches
  (`/signin`, `/signup`, `/invite/*`). `/consent` and `/onboarding` get
  the header today even though they are card pages.
- `src/components/Nav.tsx` (server, one Prisma read for `isAppOwner` and
  `adultLibraryAccess`), `NavLinks.tsx` (client, active state), and
  `UserMenu.tsx` (dropdown with Account / Admin / Sign out, shipped in
  PR #67).
- Mobile is a wrapping header row with a horizontally scrolling link strip.
  No drawer, no tabs.
- Dark-only tokens: `--bg`, `--bg-elevated`, `--bg-elevated-2`, `--bg-hover`,
  `--border`, `--text`, `--text-muted`, `--accent`, `--accent-dim`,
  `--accent-bright`. Fredoka for both display and body.
- Library pages are full-bleed; detail and settings pages self-centre at
  `max-w-5xl` and narrower. Poster grids use `CARD_COLUMNS` in
  `src/lib/card-grid.ts`, keyed on **viewport** breakpoints.

## Design

### Navigation

Primary rows, in sidebar order:

| Href | Label | Icon (lucide) | Shown when |
|---|---|---|---|
| `/` | Movies | `Film` | always |
| `/shows` | Shows | `Tv` | always |
| `/music` | Music | `Disc3` | always |
| `/collections` | Collections | `Library` | always |
| `/stats` | Stats | `ChartColumn` | always |
| `/adult` | Adult | `EyeOff` | `User.adultLibraryAccess` |

Owner rows (second group, tinted like Jingle Jotter's, only when `User.isAppOwner`):

| Href | Label | Icon |
|---|---|---|
| `/scan` | Scan | `ScanBarcode` |
| `/report` | Report | `ClipboardList` |
| `/admin` | Admin | `Shield` |

Bottom of the rail: avatar + name linking to `/account`, exactly as the
siblings do. Sign out already lives on `/account` (`SignOutButton`).

Mobile tabs: Movies, Shows, Music, Collections, More. "More" holds Stats,
Adult (gated), Scan / Report / Admin (gated), then Account after the divider.

Because two groups are gated, `nav-items.ts` exports a
`navItemsFor({ isOwner, hasAdultAccess })` helper that returns
`{ primary, owner, mobileTabs, more }`, and both `Sidebar` and `BottomTabs`
take the flags as props from `AppShell`. That keeps the visibility rule in
one file and unit-testable. As today, these are UX niceties; the pages'
`requireOwnerOrRedirect` / `requireAdultAccessOrRedirect` remain the
security boundary.

`/music/formats` is not in the nav today and stays out; it is reached from
`/music`.

### Brand in the rail

Expanded: `public/logo.png` (900×219 wordmark) at `h-7`. Collapsed rail:
the square 512×512 `src/app/icon.png`, which Next serves at `/icon.png`
(already in the proxy's public matcher), rendered at 36px as a plain
`<img>` — `next/image` is switched off in this app (see `next.config.ts`).
The mobile top bar
keeps the wordmark and the `.sprocket-rule` under it. Drop the sprocket
rule from the desktop rail for now; a vertical variant along the rail's
right edge is a follow-up if it's missed.

### Chrome gating

Adopt `AppShell`'s self-guarding instead of the layout's `x-pathname` check:

- no session → bare children (covers `/signin`, `/signup`, `/invite/*`);
- session but no `Member` row → bare (covers `/onboarding`, and invite
  landings for a signed-in user with no household yet);
- otherwise chrome.

`/consent` is signed-in with a household and must still be chrome-less, so
add `CHROMELESS_PATHS = ["/consent"]` to `src/lib/public-paths.ts` as a
**separate** list from `PUBLIC_PATHS` (adding it to `PUBLIC_PATHS` would
make it reachable signed-out). The root layout keeps reading `x-pathname`
only for this check. Do **not** introduce `(app)` / `(auth)` route groups:
`src/lib/route-guards.test.ts` keys its `SELF_MANAGED_PAGES` set on paths
relative to `src/app` and asserts those files exist.

`AppShell` does one Prisma read per request, replacing `Nav.tsx`'s:
`{ name, email, image, isAppOwner, adultLibraryAccess, sidebarCollapsed }`.

### Tokens

Write the shell in MediaVault's token names rather than renaming tokens:

| template-app | MediaVault |
|---|---|
| `bg-paper/80` (rail glass) | `bg-bg-elevated/80` |
| `border-ink/10` | `border-border` |
| active row `bg-tag text-accent-deep` | `bg-accent-dim text-accent` (today's `NavLinks` active state) |
| inactive `text-ink-soft hover:bg-tag/60 hover:text-ink` | `text-text-muted hover:bg-bg-hover hover:text-text` |
| More sheet `bg-white` | `bg-bg-elevated-2` |
| owner rows | Blu-ray blue: `text-blu/70`, `hover:bg-blu-bg hover:text-blu`, active `bg-blu-bg text-blu` — a second hue so they read as admin-only, as Jingle Jotter's berry rows do |

The film-grain `body::before` overlay at `z-index: 9999` sits above the
rail as it does above everything else. Reuse the existing
`src/components/UserAvatar.tsx` (it already has `initialsFor` and a test)
instead of copying template-app's `user-avatar.tsx`.

### Z-order

Sidebar `z-30`, bottom tabs `z-40`, More sheet and its scrim `z-40/50`.
`VideoPlayer.tsx` is `fixed inset-0 z-50` and is mounted inside `<main>`,
i.e. earlier in the DOM than `BottomTabs`. Bump the player (and
`AlbumPlayer` if it has its own overlay) to `z-[60]` so an open sheet can
never paint over it.

### Content width and the poster grid

`<main>` gets the sidebar offset as left padding, so full-bleed library
pages stay full-bleed and self-centred detail pages centre within the
remaining width. No `max-w` sweep is needed (Jingle Jotter's
`max-w-6xl → 7xl` sweep was specific to its tables).

`CARD_COLUMNS` needs re-keying, because a 16rem sidebar at `lg` leaves
roughly 690px for six columns. Switch it to Tailwind 4 container queries:
put `@container` on the wrapper that already carries `CARD_COLUMNS` and
replace the viewport variants with container variants sized so a card
stays about 150–190px wide:

```
[--cards:2] @xl:[--cards:3] @3xl:[--cards:4] @5xl:[--cards:6] @7xl:[--cards:8] @[96rem]:[--cards:10]
```

`CARD_GRID` and `SHELF_ITEM` already compute off `--cards`, so nothing
else changes. Consumers: `src/components/LibraryBrowser.tsx`,
`src/app/shows/page.tsx`.

### Auth card pages

`/signin`, `/signup`, `/invite/[token]`, `/onboarding`, `/consent` hard-code
`min-h-[calc(100vh-4rem)]` for the header that will no longer exist.
Change to `min-h-dvh`. Fix the stale comment in `AuthLogo.tsx` that says
the nav is hidden on `/consent`.

## Open decisions

1. **UserMenu.** The siblings have no dropdown: the avatar is a plain link
   to `/account`, and Admin is a sidebar row. Recommended: retire
   `UserMenu.tsx` (shipped two commits ago in PR #67) to match. The
   alternative is mounting `UserMenu` at the rail's bottom with the panel
   opening upward, which keeps the one-click sign-out but diverges from the
   other apps. Either way `scripts/e2e-passkey.ts` changes (below).
2. **Adult row on mobile.** It is gated, but "More" is a shared-device
   surface. Recommended: keep it in More, gated the same way, since the
   opt-in is per-user and the pages redirect anyway.
3. **Global search.** The roadmap's search box is a natural fit for the top
   of the expanded rail (and a magnifier row when collapsed). Not in scope,
   but leave the brand block's markup simple enough to slot it in.

## Steps

### PR 1 — shell swap (`claude/left-nav`)

1. Schema: add `sidebarCollapsed Boolean @default(false)` to `User`;
   `npx prisma migrate dev --name sidebar_collapsed`; **restart `next dev`**
   afterwards (the cached Prisma client will not see the column, and Next 16
   refuses a second dev instance until the first is killed).
2. `src/app/actions/prefs.ts`: `setSidebarCollapsed(collapsed)` — session
   check, single `prisma.user.update`, no `revalidatePath`.
3. `src/lib/public-paths.ts`: add `CHROMELESS_PATHS` + `isChromelessPath()`.
4. `src/components/shell/`: `app-shell.tsx`, `sidebar.tsx`, `top-nav.tsx`,
   `bottom-tabs.tsx`, `nav-items.ts`, ported per the token table, with the
   two TrainTracker refinements and the owner group.
5. `src/app/layout.tsx`: render `<AppShell>` (with the `x-pathname`
   chromeless check) instead of `showNav && <Nav />`; the `<main>` moves
   inside `AppShell`. MediaVault has no footer, so nothing to offset there.
6. `globals.css`: add `--sidebar-w: 0rem` to `:root` and the "Sidebar
   offset" `:has()` block.
7. Delete `Nav.tsx`, `NavLinks.tsx`, and (per decision 1) `UserMenu.tsx`.
   Keep `UserAvatar.tsx` and `SignOutButton.tsx`.
8. Auth pages: `min-h-dvh`; `AuthLogo.tsx` comment.
9. `VideoPlayer.tsx` (and album overlay): `z-[60]`.
10. Tests and scripts (below), docs (below).
11. Verify in the browser at `<md`, `md`, `lg` collapsed, `lg` expanded,
    plus `/signin`, `/onboarding`, `/consent` bare, and the player over an
    open More sheet.

### PR 2 — poster grid on container queries

Open after PR 1 merges (not stacked; see the stacked-PR note in memory).
Re-key `CARD_COLUMNS` as above and check Movies and Shows at every band with
the rail expanded and collapsed.

## Tests and scripts

- New `src/components/shell/nav-items.test.ts`: `isNavItemActive` cases
  (`/` exact, prefix elsewhere, `/music/album/x` → Music) and `navItemsFor`
  gating (owner rows only with `isOwner`, Adult only with `hasAdultAccess`).
- `scripts/e2e-passkey.ts` lines 173–176 open the account menu and click
  "Sign out"; change to navigate to `/account` and click the Sign out
  button. Line 295 asserts `>= 2` Sign out buttons on the stale page and
  will need re-counting once the menu is gone.
- `src/lib/route-guards.test.ts` is unaffected as long as no route groups
  are added and `app-shell.tsx` lives under `src/components`, not `src/app`.
- `vitest`, `lint`, `typecheck` in CI; nothing browser-driven runs
  automatically, so the band-by-band check in step 11 is manual.

## Docs to update

- `HOUSEHOLDS_PLAN.md` lines 343–346: the "deliberately not adopted"
  paragraph.
- `PLAN.md` "UI (dark, poster-forward)" section: page inventory now reached
  from the sidebar; note the search-box slot.
- `README.md` screenshots if any show the header.
- `docs/TEST_PLAN_2026-09.md`: sign-out steps now go via `/account`.
