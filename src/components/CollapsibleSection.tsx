"use client";

// A section with the shared SectionHeader whose open/closed state lives in
// the same localStorage entry LibraryBrowser uses, so every collapsible
// section across the app behaves alike. For server pages (Shows) that have
// no browser state of their own.

import { useEffect, useState, type ReactNode } from "react";
import SectionHeader from "@/components/SectionHeader";

const COLLAPSED_KEY = "mv-collapsed-sections";
// Sections that start collapsed (defaultCollapsed) need the opposite
// memory too — "this person opened it" — or expanding one would never
// stick across loads.
const EXPANDED_KEY = "mv-expanded-sections";

function readSet(key: string): Set<string> {
  const raw = localStorage.getItem(key);
  return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
}

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
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  useEffect(() => {
    try {
      // Post-mount on purpose so server and client renders agree.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (readSet(COLLAPSED_KEY).has(storageKey)) setCollapsed(true);
      else if (readSet(EXPANDED_KEY).has(storageKey)) setCollapsed(false);
    } catch {
      // Stays at the default.
    }
  }, [storageKey]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        const collapsedSet = readSet(COLLAPSED_KEY);
        const expandedSet = readSet(EXPANDED_KEY);
        if (next) {
          collapsedSet.add(storageKey);
          expandedSet.delete(storageKey);
        } else {
          collapsedSet.delete(storageKey);
          expandedSet.add(storageKey);
        }
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedSet]));
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedSet]));
      } catch {
        // Per-browser convenience only.
      }
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={title} count={count} collapsed={collapsed} onToggle={toggle} noun={noun} />
      {!collapsed && children}
    </section>
  );
}
