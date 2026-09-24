"use client";

// Home's rows (getHomeRows), drawn the way the Apple TV draws them: each an
// ExpandingRow, the first — Top Picks — taller and always showing a card
// open. Owns which row is active, since only that one shows its details:
// the one with the open card, or Top Picks when none has.
//
// A row's details appearing or vanishing moves every row below it, which
// under a resting mouse would slide a different row beneath the pointer
// (and open that one, and so on). So whenever the active row changes, the
// row that caused it is kept where it was on screen: its position is noted
// before the change and the page scrolled by however far it moved after.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import ExpandingRow from "@/components/home/ExpandingRow";
import type { HomeData } from "@/lib/home-rows";

export default function HomeRows({ data }: { data: HomeData }) {
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  // The same, readable synchronously in the handlers below (two rows can
  // hand over within one event: focus leaving one card for the next row's).
  const activeRef = useRef<string | null>(null);
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null);

  const change = useCallback((next: string | null, el: HTMLElement) => {
    activeRef.current = next;
    anchor.current = { el, top: el.getBoundingClientRect().top };
    setActiveRowId(next);
  }, []);

  const onActivate = useCallback(
    (rowId: string, el: HTMLElement) => {
      if (activeRef.current !== rowId) change(rowId, el);
    },
    [change],
  );

  const onDeactivate = useCallback(
    (rowId: string, el: HTMLElement) => {
      if (activeRef.current === rowId) change(null, el);
    },
    [change],
  );

  useLayoutEffect(() => {
    const noted = anchor.current;
    anchor.current = null;
    if (!noted || !noted.el.isConnected) return;
    const moved = noted.el.getBoundingClientRect().top - noted.top;
    if (Math.abs(moved) >= 1) window.scrollBy({ top: moved, behavior: "instant" });
  }, [activeRowId]);

  if (data.rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <p className="font-display text-2xl tracking-wide text-text-muted">Nothing here yet</p>
        <p className="max-w-sm text-sm text-text-faint">
          Home fills up once films, shows or music are in the library.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-4">
      {data.rows.map((row, index) => (
        <ExpandingRow
          key={row.id}
          row={row}
          films={data.films}
          hero={index === 0}
          active={activeRowId === row.id}
          idle={activeRowId === null}
          onActivate={onActivate}
          onDeactivate={onDeactivate}
        />
      ))}
    </div>
  );
}
