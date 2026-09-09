"use client";

// Small "…" popover attached to a track row or an album/playlist header —
// Play / Play next / Add to queue for whatever QueueTrack(s) it's handed.
// Styled like the bottom-tabs "More" sheet (see shell/bottom-tabs.tsx),
// scaled down to a row-anchored popover instead of a full-width sheet.

import { useEffect, useRef, useState } from "react";
import { Ellipsis, FolderPlus, ListPlus, ListStart, Play } from "lucide-react";
import { usePlayer } from "./usePlayer";
import AddToPlaylistMenu from "./AddToPlaylistMenu";
import type { PlaybackContext, QueueTrack } from "@/lib/player-types";

const menuItem = "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-text hover:bg-bg-hover";

export default function TrackMenu({
  tracks,
  label,
  context,
  align = "right",
  size = "sm",
}: {
  /** One track (a row's own menu) or many (an album/playlist header's). */
  tracks: QueueTrack[];
  /** Used only for the aria-label: "Actions for <label>". */
  label: string;
  context?: PlaybackContext;
  align?: "left" | "right";
  size?: "sm" | "md";
}) {
  const { engine } = usePlayer();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "playlist">("menu");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Closing always lands back on the main menu next time this opens —
  // set alongside setOpen(false) at every close site rather than in an
  // effect, so there's no synchronous setState-in-effect cascade.
  function closeMenu() {
    setOpen(false);
    setView("menu");
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeMenu();
      buttonRef.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function runAndClose(action: () => void) {
    action();
    closeMenu();
  }

  const ariaLabel = `Actions for ${label}`;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          // A row's menu button lives inside track rows that may sit under
          // a Link (album art, artist link) elsewhere on the page — never
          // let the click bubble into a navigation.
          e.stopPropagation();
          setOpen((o) => !o);
          setView("menu");
        }}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text ${
          size === "sm" ? "h-7 w-7" : "h-8 w-8"
        }`}
      >
        <Ellipsis aria-hidden className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className={`absolute top-full z-50 mt-1 flex flex-col gap-0.5 rounded-xl border border-border bg-bg-elevated-2 p-1 shadow-lg shadow-black/50 ${
            view === "playlist" ? "w-56" : "w-44"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {view === "menu" ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  runAndClose(() => engine.playTracks(tracks, { context }));
                }}
                className={menuItem}
              >
                <Play aria-hidden className="h-4 w-4" />
                Play
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  runAndClose(() => engine.playNext(tracks, context));
                }}
                className={menuItem}
              >
                <ListStart aria-hidden className="h-4 w-4" />
                Play next
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  runAndClose(() => engine.addToQueue(tracks, context));
                }}
                className={menuItem}
              >
                <ListPlus aria-hidden className="h-4 w-4" />
                Add to queue
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setView("playlist");
                }}
                className={menuItem}
              >
                <FolderPlus aria-hidden className="h-4 w-4" />
                Add to playlist ▸
              </button>
            </>
          ) : (
            <AddToPlaylistMenu
              trackIds={tracks.map((t) => t.trackId)}
              onBack={() => setView("menu")}
              onDone={closeMenu}
            />
          )}
        </div>
      )}
    </div>
  );
}
