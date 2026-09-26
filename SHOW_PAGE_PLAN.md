# Show page — one design for the iPhone app, the phone web and the Apple TV

Decided by Mark on 24 September 2026 with the same side-by-side sheet as the
film page (our iPhone app, our website on a phone, and Netflix's page for
*Stargate SG-1*). It carries FILM_PAGE_PLAN.md's choices across wherever the
two pages have the same part, so a film and a show read as one app. Netflix
auto-plays a clip at the top; we never do.

## The page, top to bottom

1. **Top — floating controls only (app).** As the film page: a round,
   translucent Back over the artwork; a `⋯` only for the owner (below). No
   logo bar.

2. **Hero (blend).** As the film page: the show's backdrop (a still) full
   bleed, fading into the page, with the show's TMDB title logo centred over
   the fade; text title when there's no logo; the poster, blurred, when
   there's no backdrop. Wide screens: 16:9 with the details over its lower
   left, as the film page.

3. **Chips, then the quiet line (blend).** Chips: the certificate, then for
   the files you have: `HD` / `SD`, `5.1` where heard. The quiet line:
   `1997–2007 · 10 seasons · Sci-Fi & Fantasy, Action & Adventure · ★ 8.3`
   — first to last air year (one year if one; `1997–` while still running),
   the number of seasons the show has (specials not counted), genres as
   plain text, TMDB rating. When you don't have every episode, a small line
   under it: `You have 21 of 213 episodes`. No resolution, codec or disc
   format.

4. **Play and actions (blend).** As the film page: one full-width amber
   button with ▶ — `Play – Season 1, Episode 1` for a show you haven't started, `Resume – Season 2, Episode 8`
   (or `Play – Season 2, Episode 9`, the next one) for one you have — then a centred row of
   labelled icon buttons: **Favourite** · **Watched** (reset every episode's
   progress, with a confirmation, only when there is some).

5. **Synopsis (Netflix).** After the actions, three lines then "More", so
   the episodes start on the first screen.

6. **Season menu (Netflix).** A `Season 1 ⌄` menu button above the episodes
   (phone and web): a menu of the seasons you have episodes in, in order,
   specials last; it opens on the season you're partway through. Only when
   there's more than one. The Apple TV keeps its row of text tabs.

7. **Episode rows (web).** Per episode you have: a 16:9 still you press to
   play (a play glyph over it; an amber progress bar along its foot when
   you're partway; a "Watched" tick when done), then `1. Children of the
   Gods`, `46m · Ends at 17:29` (the episode's runtime, and when it would
   finish if started now), and two lines of its synopsis. Tapping the row
   (not the still) expands the synopsis. Nothing technical (no 576p).
   Episodes you don't have are left out.

8. **Below the episodes (blend).** Rows rather than tabs, as on the film
   page: **Films** — the films linked to the show (`ShowDetailResponse.films`,
   e.g. Stargate: Continuum) — then **More like this**: shows sharing its
   genres (`ShowSummary.genres`), up to a dozen.

## Owner tools (neither)

"Link to a film" moves into the owner-only `⋯` menu at the top (as the film
page's owner tools), not on the page itself.

## Apple TV

MediaVault-Player `TVShowDetailView`: the backdrop and logo fill the screen with
the text bottom-left; chips and quiet line; Resume/Play and labelled
Favourite · Watched; three lines of synopsis; the text tabs for seasons;
episode rows as above (still, number and title, runtime · ends at, two
lines); Films and More like this as sliding rows below.
