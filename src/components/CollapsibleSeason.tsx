"use client";

// A season's fold on the show page. CollapsibleSection can't be reused as
// it stands — a season's heading is a poster, a title, a spec line and an
// owned count rather than SectionHeader's title-and-count — so the heading
// comes in as a slot and only the chevron, the button and the memory
// (useCollapsed) are shared with it.
//
// The heading is the whole button: it stays on screen when the season is
// folded, which is the point of folding — the shape of a seven-season show
// should be readable without scrolling past every episode.

import { type ReactNode } from "react";
import { ChevronIcon } from "@/components/SectionHeader";
import { useCollapsed } from "@/lib/use-collapsed";

export default function CollapsibleSeason({
  storageKey,
  defaultCollapsed,
  header,
  children,
}: {
  storageKey: string;
  defaultCollapsed: boolean;
  /** The season heading's contents, rendered on the server and slotted in
   *  beside the chevron. */
  header: ReactNode;
  children: ReactNode;
}) {
  const { collapsed, toggle } = useCollapsed(storageKey, defaultCollapsed);

  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 border-b border-border pb-2 text-left"
      >
        <ChevronIcon collapsed={collapsed} />
        {header}
      </button>
      {!collapsed && children}
    </section>
  );
}
