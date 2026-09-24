"use client";

// The show page's `Series 1 ⌄` (SHOW_PAGE_PLAN.md "Season menu"): a button
// naming the season on show, opening a short list of the seasons you have
// episodes in. A listbox popup, so it works from the keyboard the way a
// native select does — arrows move, Home/End jump, Enter or Space picks,
// Escape or Tab closes — without a native select's look.

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SeasonOption {
  seasonNumber: number;
  label: string;
  /** "8 episodes" — a quiet count beside the label in the list. */
  detail: string;
}

export default function SeasonMenu({
  options,
  value,
  onChange,
}: {
  options: SeasonOption[];
  value: number;
  onChange: (seasonNumber: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.seasonNumber === value) ?? options[0];

  function openList() {
    setActive(Math.max(0, options.findIndex((o) => o.seasonNumber === value)));
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function pick(index: number) {
    const option = options[index];
    if (option) onChange(option.seasonNumber);
    close();
  }

  // Focus moves into the list when it opens, so its keys land there.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // A long list keeps the highlighted season in view as the arrows move.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  // A tap or click anywhere else closes it without choosing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(active);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative w-fit">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openList();
          }
        }}
        className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 py-2 font-display text-base font-semibold text-text transition-colors hover:bg-bg-hover"
      >
        {current.label}
        <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="Season"
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          // z-30: over the episode rows, under the shell's tab bar (z-40).
          className="absolute left-0 top-full z-30 mt-1.5 max-h-[60svh] min-w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated-2 p-1 shadow-lg shadow-black/50 focus-visible:outline-none"
        >
          {options.map((o, i) => {
            const selected = o.seasonNumber === value;
            return (
              <li
                key={o.seasonNumber}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={`flex cursor-pointer items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm ${
                  i === active ? "bg-bg-hover" : ""
                } ${selected ? "font-semibold text-text" : "text-text-muted"}`}
              >
                <span className="flex-1">{o.label}</span>
                <span className="text-xs font-normal text-text-faint">{o.detail}</span>
                <Check aria-hidden className={`h-4 w-4 text-accent ${selected ? "" : "invisible"}`} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
