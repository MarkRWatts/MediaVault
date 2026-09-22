"use client";

// The "up next" list under the Now Playing card — desktop rail (rail.tsx)
// and the mobile full-screen sheet (mobile-player-bar.tsx) both render
// this below <NowPlayingCard />. Reads straight off the engine's snapshot
// (src/lib/player-engine.ts via usePlayer()); every mutation (reorder,
// remove, clear, jump) goes straight to the engine and the snapshot
// re-render is what updates the list — no local state here at all.

import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import { usePlayer } from "@/components/player/usePlayer";
import { formatTime } from "@/lib/format-time";

export function QueuePanel() {
  const { snapshot, engine } = usePlayer();
  const { queue, order, currentKey } = snapshot;
  const currentRowRef = useRef<HTMLLIElement | null>(null);

  // The list keeps growing as tracks play, so when the current entry moves
  // bring it back into view rather than leaving the panel scrolled to
  // wherever it happened to be.
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentKey]);

  if (queue.length === 0) return null;

  const byKey = new Map(queue.map((e) => [e.key, e]));
  const currentIdx = currentKey != null ? order.indexOf(currentKey) : -1;
  // Everything stays visible, played tracks included, so the panel reads as
  // a real history — but the header count is still "what's left to hear",
  // matching rail.tsx's own remainingCount badge.
  const upcomingCount = order.length - Math.max(currentIdx, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-xs font-semibold tracking-wide text-text-muted">
          Queue · {upcomingCount} to play
        </h3>
        <button
          type="button"
          onClick={() => engine.clearQueue()}
          className="text-xs text-text-muted hover:text-text hover:underline"
        >
          Clear
        </button>
      </div>

      <ul className="flex flex-col gap-0.5">
        {order.map((key) => {
          const entry = byKey.get(key);
          if (!entry) return null;
          const isCurrent = key === currentKey;
          const orderIdx = order.indexOf(key);
          const isPlayed = currentIdx !== -1 && orderIdx < currentIdx;
          const disableUp = isCurrent || isPlayed || orderIdx <= 0;
          const disableDown = isCurrent || isPlayed || orderIdx >= order.length - 1;

          function handleKeyDown(e: KeyboardEvent<HTMLLIElement>) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              engine.jumpTo(key);
            }
          }

          return (
            <li
              key={key}
              ref={isCurrent ? currentRowRef : undefined}
              role="button"
              tabIndex={0}
              onClick={() => engine.jumpTo(key)}
              onKeyDown={handleKeyDown}
              className={`flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-bg-hover ${isPlayed ? "opacity-60" : ""}`}
            >
              <CoverImage
                albumId={entry.hasCover ? entry.albumId : null}
                version={entry.coverVersion}
                title={entry.albumTitle}
                fallback="glyph"
                className="h-8 w-8 shrink-0 rounded"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm ${isCurrent ? "text-format-digital" : isPlayed ? "text-text-faint" : "text-text"}`}
                >
                  {entry.title}
                </p>
                <p className={`truncate text-xs ${isPlayed ? "text-text-faint" : "text-text-muted"}`}>
                  {entry.artist}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-text-faint">
                {formatTime(entry.durationSecs)}
              </span>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    engine.moveInQueue(key, orderIdx - 1);
                  }}
                  disabled={disableUp}
                  aria-label={`Move "${entry.title}" up in queue`}
                  className="p-1 text-text-muted hover:text-text disabled:opacity-30"
                >
                  <ChevronUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    engine.moveInQueue(key, orderIdx + 1);
                  }}
                  disabled={disableDown}
                  aria-label={`Move "${entry.title}" down in queue`}
                  className="p-1 text-text-muted hover:text-text disabled:opacity-30"
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    engine.removeFromQueue(key);
                  }}
                  aria-label={`Remove ${entry.title} from queue`}
                  className="p-1 text-text-muted hover:text-text"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
