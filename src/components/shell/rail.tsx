"use client";

// Desktop chrome: a floating glass rail, fixed to the right edge, mirroring
// sidebar.tsx's mechanism and glass language. Carries the persistent Now
// Playing card + queue once something's in the player (components/player/
// PlayerProvider.tsx), so playback controls survive client-side navigation
// the same way the engine itself does.
//
// Same CSS-only collapse trick as the sidebar: this component doesn't know
// its own breakpoint at render time, so instead of branching on viewport
// width in JS it stamps the live collapse state onto the <aside> itself
// (`data-collapsed`) and lets `xl:group-data-[collapsed=false]:` variants
// react to that. One breakpoint later than the sidebar's `lg` — see
// globals.css's "Rail offset" block for why (a 16rem sidebar + 20rem rail
// at `lg` would leave ~450px for content). Below `xl` the rail is forced to
// the 4.5rem icon strip regardless of the stored preference. The same
// `data-collapsed` (plus `id="app-rail"`) is how globals.css's
// `body:has(#app-rail...)` rule derives --rail-w for <main>, which isn't a
// descendant of this component.
//
// Unlike the sidebar, the rail also hides itself entirely — most pages have
// nothing to show here. It renders nothing until there's a queue or the
// visitor is somewhere under /music; both checks are SSR-safe (the engine's
// snapshot is always EMPTY_SNAPSHOT at hydration, and usePathname agrees
// between server and client render), so there's no hydration flash.

import { useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { PanelRightClose, PanelRightOpen, ListMusic } from "lucide-react";
import { setRailCollapsed } from "@/app/actions/prefs";
import { usePlayer } from "@/components/player/usePlayer";
import { PlayIcon, PauseIcon } from "@/components/player/icons";
import CoverImage from "@/components/CoverImage";
import { NowPlayingCard } from "./now-playing-card";
import { QueuePanel } from "./queue-panel";

/** How many entries remain from the current one onward — the same count
 *  QueuePanel's own heading uses, mirrored here for the collapsed strip's
 *  badge. */
function remainingCount(order: number[], currentKey: number | null): number {
  if (order.length === 0) return 0;
  const idx = currentKey != null ? order.indexOf(currentKey) : 0;
  return order.length - Math.max(idx, 0);
}

export function Rail({ initialCollapsed }: { initialCollapsed: boolean }) {
  const pathname = usePathname();
  const { snapshot, engine } = usePlayer();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [, startTransition] = useTransition();

  // Flip instantly for the click that triggered it; persist in the
  // background, same as the sidebar's applyCollapsed.
  function applyCollapsed(next: boolean) {
    setCollapsed(next);
    startTransition(() => {
      setRailCollapsed(next).catch(() => {
        // Best-effort persistence; a failed write just means next load
        // falls back to the last-saved state. Nothing to surface here.
      });
    });
  }

  if (snapshot.queue.length === 0 && !pathname.startsWith("/music")) return null;

  const { current } = snapshot;
  const isPlaying = snapshot.status === "playing" || snapshot.status === "loading";
  const queueEmpty = snapshot.queue.length === 0;
  const count = remainingCount(snapshot.order, snapshot.currentKey);
  const ToggleIcon = collapsed ? PanelRightOpen : PanelRightClose;

  return (
    <aside
      id="app-rail"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Player"
      // group: scopes every `group-data-[collapsed=…]` element below to
      // this element's own data-collapsed, not some outer ancestor's.
      className="group fixed top-4 bottom-4 right-[max(1rem,env(safe-area-inset-right))] z-30 hidden w-[var(--rail-w)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated/85 shadow-lg shadow-black/40 backdrop-blur-md transition-[width] motion-reduce:transition-none md:flex"
    >
      {/* Collapse toggle: only meaningful at xl+ (below that the rail is
          forced regardless), so hidden entirely below xl — same pattern as
          the sidebar's own toggle. Lives outside the two content blocks
          below so it's available in both the collapsed and expanded
          layouts without duplicating it. */}
      <button
        type="button"
        onClick={() => applyCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand player" : "Collapse player"}
        title={collapsed ? "Expand player" : "Collapse player"}
        className="mt-3 hidden shrink-0 items-center justify-center self-center rounded-full p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text xl:flex xl:group-data-[collapsed=false]:self-start xl:group-data-[collapsed=false]:ml-3"
      >
        <ToggleIcon size={18} aria-hidden="true" />
      </button>

      {/* Collapsed strip: the icon-only column, shown whenever the full
          card isn't — i.e. always below xl (forced), and above xl only
          while collapsed. */}
      <div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto px-2 py-3 xl:group-data-[collapsed=false]:hidden">
        <button
          type="button"
          onClick={() => applyCollapsed(false)}
          aria-label={current ? `Now playing: ${current.title}` : "Open player"}
          className="shrink-0 overflow-hidden rounded"
        >
          <CoverImage
            albumId={current?.hasCover ? current.albumId : null}
            version={current?.coverVersion}
            title={current?.albumTitle ?? "Nothing playing"}
            fallback="glyph"
            className="h-10 w-10"
          />
        </button>
        <button
          type="button"
          onClick={() => engine.toggle()}
          disabled={queueEmpty}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="shrink-0 text-text hover:text-format-digital disabled:opacity-30"
        >
          {isPlaying ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => applyCollapsed(false)}
          aria-label={`Queue, ${count} track${count === 1 ? "" : "s"}`}
          className="relative shrink-0 text-text-muted hover:text-text"
        >
          <ListMusic size={20} aria-hidden="true" />
          {count > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-format-digital px-1 text-[9px] font-semibold text-bg">
              {count}
            </span>
          )}
        </button>
      </div>

      {/* Expanded: the full Now Playing card + queue, only at xl+ once
          not collapsed. */}
      <div className="hidden flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-3 py-4 xl:group-data-[collapsed=false]:flex">
        <NowPlayingCard />
        <QueuePanel />
        {/* Future: <PlaylistsPanel /> — quick-add-to-playlist list below
            the queue, once playlists ship. */}
      </div>
    </aside>
  );
}
