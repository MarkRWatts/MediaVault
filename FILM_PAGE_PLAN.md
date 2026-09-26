# Film page — one design for the iPhone app, the phone web and the Apple TV

Decided by Mark on 24 September 2026 with a side-by-side sheet (our iPhone
app, our website on a phone, and Disney+'s page for *Maleficent: Mistress of
Evil*), one choice per part of the page. This is what both apps build to;
where a platform needs to differ it says so.

## The page, top to bottom

1. **Top — floating controls only (app).** No logo bar on a film page. A
   round, translucent Back button top-left over the artwork; a round `⋯`
   top-right only when there's something in it (nothing for members today).
   The web's logo bar stays on top-level pages (Home, Movies, Shows, Music).

2. **Hero — backdrop and title logo (Disney+).** No poster. The film's
   backdrop (`w1280`) full-bleed across the top ~45% of the screen, fading
   into the page background at its foot; the film's TMDB title logo
   (`logoPath`, `w500`) centred over the fade, at most ~70% of the width and
   ~120 pt tall. No logo, or it fails: the title as text in the heading face.
   No backdrop: the poster, blurred and darkened, as the backdrop.

3. **Chips, then the quiet line (blend).** Centred.
   - A row of chips: certificate (the BBFC symbol, as now), then for the
     **best copy the film has**: `Ultra HD` (4K) or `HD`, `HDR` / `Dolby
     Vision` if that copy has it, `5.1` / `7.1` as heard (VideoBadges'
     rule). Filled chips (a subtle raised fill, text colour), not outlines.
   - One quiet line under them: `2019 · 1h 59m · Family, Fantasy, Adventure ·
     ★ 7.3` — year, runtime, **genres as plain text (app)**, TMDB rating.
   - Web bug to fix on the way: the web showed `HD` for a film whose best copy
     is 4K HDR — the chips come from the best copy, not the first.

4. **Actions (Disney+).**
   - One full-width **Play** button in our amber, with a ▶ triangle icon and
     the label `Play`, or `Resume from 37:43` when there's a position to go
     back to. It plays the copy chosen in Quality (below).
   - When resuming, a second, quieter full-width button: `Play from the
     Beginning`.
   - Under them, a centred row of labelled icon buttons (icon above a small
     caption, like Disney+'s Trailer · Watchlist · Download):
     **Favourite** (heart, filled when on) · **Watched** (eye-slash: reset
     watch status, shown only when there's something to reset, with a
     confirmation) · **Quality** (only when the film has more than one copy;
     caption shows the current choice, e.g. `Ultra HD`).

5. **Synopsis (web order).** After the actions, full width, larger than the
   quiet line, up to ~6 lines then "More".

6. **More like this (blend).** A row headed `More like this`: the other films
   in its collection first (in release order), then films sharing its
   genres, up to ~12. Posters, tap to open. (No tabs: with Versions gone
   there'd only be one.)

## Quality — choosing the copy (Neither: no Versions section)

There is no Versions section and no technical detail (codec, bitrate, file
size, SDR/HDR10) on the film page: most viewers don't care, and two copies
listed with their specs is clunky. Instead the **Quality** action picks the
copy, named in plain words, one option per kind the film actually has:

| Copy (`Version.format`) | Label |
|---|---|
| `UHD` | **Ultra HD (4K Blu-ray)** |
| `BLURAY` | **High Definition (Blu-ray)** |
| `DVD` | **Standard (DVD)** |
| `HD` (a digital HD file) | **High Definition** |
| `SD` | **Standard** |

- Two copies of the same kind (an extended cut): the edition follows the
  label — `High Definition (Blu-ray) · Extended Edition`.
- **Default** is the best copy this device can play here: Ultra HD only
  where it plays (direct play on a device that decodes HEVC; not on the web
  except Safari once that lands); otherwise the best of the rest. A position
  already saved on a copy keeps the film on that copy (as today).
- The audio-track picker goes with the Versions cards; the default track
  plays (as the Apple TV does). Revisit only if someone asks.

**Streaming quality is separate.** Today the app's film-page "Quality:
Original quality" sets how hard the server compresses on a slow link. That
becomes a setting in Account ("Stream at lower quality on mobile data" /
remote), applied automatically — not on the film page.

## Owner tools (Neither)

"Link a show" / "Edit shows" leaves the film page entirely. Linking a film
and a show is done from the **show** page ("Link to a film"), for the owner
only — or an admin page if that proves tidier; it's needed for a handful of
titles.

## Everywhere

- **Tab bar (app):** `Home · Movies · Shows · Music · Search`, the same five,
  same labels, on the iPhone app and the phone web. The web's extras
  (Collections, History, Adult, admin) move to the account menu (the avatar);
  a desktop sidebar may keep them below the five.
- **Type (app):** SF Pro Rounded for headings, SF Pro for text — on the web
  too, where the viewer is on an Apple device or Safari; Fredoka for
  everything else. In CSS: text `-apple-system, BlinkMacSystemFont,
  "Fredoka", sans-serif`; headings `ui-rounded, "SF Pro Rounded",
  "Fredoka", sans-serif` (only Apple systems resolve the first names; the
  rest fall through to Fredoka). JetBrains Mono stays for tabular figures.

## Apple TV

The same page, laid out for the TV (MediaVault-Player `TVFilmDetailView`): the
backdrop and logo fill the screen, the text sits bottom-left rather than
centred, and Play keeps its width to its label (a full-width button reads
oddly on a television). Otherwise as above: chips, then the quiet line;
Play/Resume and Play from the Beginning, then labelled Favourite · Watched ·
Quality buttons; the synopsis; and More like this below the first screen,
as a Home-style row that slides under a fixed wide spot. Tab bar: the TV
keeps its top bar (Home · Movies · TV Shows · Music · Search · Settings).
