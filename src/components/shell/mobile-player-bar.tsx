"use client";

// Mobile equivalent of the rail (rail.tsx doesn't render below md — its
// glass card is a desktop pattern; a phone gets a slim strip above the
// bottom tab bar instead, tapping into a full-screen sheet for the real
// Now Playing card + queue). Same glass recipe as bottom-tabs.tsx, offset
// to stack directly above it.

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import { usePlayer } from "@/components/player/usePlayer";
import { PlayIcon, PauseIcon, NextIcon } from "@/components/player/icons";
import { NowPlayingCard } from "./now-playing-card";
import { QueuePanel } from "./queue-panel";

export function MobilePlayerBar() {
  const { snapshot, engine } = usePlayer();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { current } = snapshot;

  // Escape closes the sheet, same as any other modal in the app.
  useEffect(() => {
    if (!sheetOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSheetOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen]);

  if (!current) return null;

  const isPlaying = snapshot.status === "playing" || snapshot.status === "loading";

  return (
    <>
      {/* Same offset math as bottom-tabs.tsx's own bottom-[...] plus that
          bar's ~3.5rem height and a 0.5rem gap, so the strip floats
          directly above it rather than overlapping. */}
      <div
        id="app-player-bar"
        className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem+3.5rem+0.5rem)] z-40 flex items-center gap-3 rounded-2xl border border-border bg-bg-elevated/90 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur-md md:hidden"
      >
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label={`Open player: ${current.title}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <CoverImage
            albumId={current.hasCover ? current.albumId : null}
            version={current.coverVersion}
            title={current.albumTitle}
            fallback="glyph"
            className="h-10 w-10 shrink-0 rounded"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text">{current.title}</p>
            <p className="truncate text-xs text-text-muted">{current.artist}</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => engine.toggle()}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="shrink-0 text-text hover:text-format-digital"
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={() => engine.next()}
          aria-label="Next track"
          className="shrink-0 text-text-muted hover:text-text"
        >
          <NextIcon />
        </button>
      </div>

      {sheetOpen && (
        <div role="dialog" aria-modal="true" aria-label="Now playing" className="fixed inset-0 z-50 flex flex-col bg-bg md:hidden">
          <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
            <span className="font-display text-sm font-medium tracking-wide text-text-muted">Now Playing</span>
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              aria-label="Close player"
              className="rounded-full p-2 text-text-muted hover:bg-bg-hover hover:text-text"
            >
              <ChevronDown size={22} aria-hidden="true" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="mx-auto flex max-w-sm flex-col gap-6">
              <NowPlayingCard />
              <QueuePanel />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
