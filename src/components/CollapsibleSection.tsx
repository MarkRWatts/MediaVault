"use client";

// A section with the shared SectionHeader whose open/closed state lives in
// the same localStorage entry LibraryBrowser uses, so every collapsible
// section across the app behaves alike. For server pages (Shows) that have
// no browser state of their own.

import { type ReactNode } from "react";
import SectionHeader from "@/components/SectionHeader";
import { useCollapsed } from "@/lib/use-collapsed";

export default function CollapsibleSection({
  storageKey,
  title,
  count,
  noun,
  defaultCollapsed = false,
  children,
}: {
  /** Unique across the app, e.g. "shows:Continue watching". */
  storageKey: string;
  title: string;
  count: number;
  /** Singular noun the count pluralizes — see SectionHeader. */
  noun?: string;
  /** Start folded until this person opens it (a "Not owned" list). */
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const { collapsed, toggle } = useCollapsed(storageKey, defaultCollapsed);

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={title} count={count} collapsed={collapsed} onToggle={toggle} noun={noun} />
      {!collapsed && children}
    </section>
  );
}
