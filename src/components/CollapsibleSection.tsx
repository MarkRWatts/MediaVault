"use client";

// A section with the shared SectionHeader whose open/closed state lives in
// the same localStorage entry LibraryBrowser uses, so every collapsible
// section across the app behaves alike. For server pages (Shows) that have
// no browser state of their own.

import { useEffect, useState, type ReactNode } from "react";
import SectionHeader from "@/components/SectionHeader";

const COLLAPSED_KEY = "mv-collapsed-sections";

export default function CollapsibleSection({
  storageKey,
  title,
  count,
  children,
}: {
  /** Unique across the app, e.g. "shows:Continue watching". */
  storageKey: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      // Post-mount on purpose so server and client renders agree.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw && (JSON.parse(raw) as string[]).includes(storageKey)) setCollapsed(true);
    } catch {
      // Stays open.
    }
  }, [storageKey]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem(COLLAPSED_KEY);
        const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
        if (next) set.add(storageKey);
        else set.delete(storageKey);
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
      } catch {
        // Per-browser convenience only.
      }
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={title} count={count} collapsed={collapsed} onToggle={toggle} />
      {!collapsed && children}
    </section>
  );
}
