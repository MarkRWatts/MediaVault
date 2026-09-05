// One column ladder for every poster card on the Movies and Shows pages, so
// the browse grid and the horizontal shelves (Continue watching, New
// releases, Recently added, Favourites) show the same number of cards
// across at any width and their cards are the same size. Ten across on a
// wide monitor (2xl), scaling down to two on a phone.
//
// Mechanism: a wrapper sets `--cards` per breakpoint; the grid uses it as
// its column count and a shelf item takes exactly one column's width
// (container width minus the gaps, divided by the count), so N cards are
// visible and the rest scroll.

/** Put on an ancestor of both grids and shelves. */
export const CARD_COLUMNS = "[--cards:2] sm:[--cards:3] md:[--cards:4] lg:[--cards:6] xl:[--cards:8] 2xl:[--cards:10]";

/** The browse grid. gap-3 = 0.75rem, matched in SHELF_ITEM. */
export const CARD_GRID = "grid gap-3 grid-cols-[repeat(var(--cards),minmax(0,1fr))]";

/** One card in a scrolling shelf (a flex row with gap-3). */
export const SHELF_ITEM = "shrink-0 w-[calc((100%_-_(var(--cards)_-_1)_*_0.75rem)_/_var(--cards))]";
