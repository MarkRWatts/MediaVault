"use client";

// The "/music" entry point into the built-in, non-editable Favourite tracks
// list: a stat-tile-shaped card (matches the Artists/Albums/Tracks tiles
// above it) with a Play button that loads the queue via the
// loadPlaylistQueue("favourites") server action and hands it straight to
// the engine — no page visit needed, same as the rail's pinned row.

import { useTransition } from "react";
import Link from "next/link";
import { Heart } from "lucide-react";
import { usePlayer } from "@/components/player/usePlayer";
import { PlayIcon } from "@/components/player/icons";
import { loadPlaylistQueue } from "@/app/actions/music-state";

export default function FavouriteTracksTile({ count }: { count: number }) {
  const { engine } = usePlayer();
  const [pending, startTransition] = useTransition();

  function handlePlay() {
    startTransition(async () => {
      const tracks = await loadPlaylistQueue("favourites");
      engine.playTracks(tracks, { context: { kind: "favourites" } });
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated p-3.5">
      <Heart aria-hidden className="h-6 w-6 shrink-0 fill-pink-400 text-pink-400" />
      <Link href="/music/favourites" className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-text">Favourite tracks</span>
        <span className="font-mono text-xs text-text-faint">
          {count} track{count === 1 ? "" : "s"}
        </span>
      </Link>
      <button
        type="button"
        onClick={handlePlay}
        disabled={pending || count === 0}
        aria-label="Play favourite tracks"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-format-digital-border bg-format-digital-bg text-format-digital transition-colors hover:bg-format-digital/25 disabled:cursor-default disabled:opacity-40"
      >
        <PlayIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
