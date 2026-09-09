// One column ladder for every poster card on the Movies and Shows pages, so
// the browse grid and the horizontal shelves (Continue watching, New
// releases, Recently added, Favourites) show the same number of cards
// across at any width and their cards are the same size. Six across on a
// desktop, scaling down to two on a phone.
//
// Mechanism: a wrapper sets `--cards` per width step; the grid uses it as
// its column count and a shelf item takes exactly one column's width
// (container width minus the gaps, divided by the count), so N cards are
// visible and the rest scroll.
//
// The steps are container queries against the app shell's <main>
// (`@container`, see components/shell/app-shell.tsx), not viewport
// breakpoints: the floating sidebar takes 4.5–16rem off the width
// available to content, so a viewport-keyed ladder would squeeze ten
// 138px cards into the space that comfortably fits eight. Each step is
// the <main> width at which one more column still leaves every card
// ≥ ~140px (<main> width, minus the page's 3rem padding and the gaps,
// over the count), so cards sit in the same ~140–190px band the old
// viewport ladder produced, whatever the rail is doing. The other library
// grids — collections, music, adult, report, stats — use the same steps
// inline; keep them in sync by hand.

/** Put on an ancestor of both grids and shelves. Tops out at six: with
 *  the sidebar and the player rail both open, eight or ten across squeezed
 *  posters below ~150px on an ordinary desktop, so the ladder now stops
 *  where a card is still a poster rather than a thumbnail. */
export const CARD_COLUMNS = "[--cards:2] @lg:[--cards:3] @2xl:[--cards:4] @min-[60rem]:[--cards:6]";

/** The browse grid. gap-3 = 0.75rem, matched in SHELF_ITEM. */
export const CARD_GRID = "grid gap-3 grid-cols-[repeat(var(--cards),minmax(0,1fr))]";

/** One card in a scrolling shelf (a flex row with gap-3). */
export const SHELF_ITEM = "shrink-0 w-[calc((100%_-_(var(--cards)_-_1)_*_0.75rem)_/_var(--cards))]";
