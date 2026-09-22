"use client";

// One section's open/closed memory, shared by CollapsibleSection (the
// shelves) and CollapsibleSeason (a show's seasons) so every fold in the app
// remembers itself the same way and in the same localStorage entries
// LibraryBrowser writes.

import { useEffect, useState } from "react";

const COLLAPSED_KEY = "mv-collapsed-sections";
// Sections that start collapsed (defaultCollapsed) need the opposite
// memory too — "this person opened it" — or expanding one would never
// stick across loads.
const EXPANDED_KEY = "mv-expanded-sections";

function readSet(key: string): Set<string> {
  const raw = localStorage.getItem(key);
  return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
}

/** `storageKey` must be unique across the app, e.g. "shows:Continue
 *  watching" or "show:12:season:3". */
export function useCollapsed(storageKey: string, defaultCollapsed: boolean) {
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

  return { collapsed, toggle };
}
