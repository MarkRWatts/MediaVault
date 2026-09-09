"use client";

// The rail's playlists list — for now just the pinned, built-in "Favourite
// tracks" row (see PLAYLISTS_PLAN.md's PR2). Row style mirrors
// queue-panel.tsx's rows. PR3 lists the signed-in person's own playlists
// beneath this row and adds a "New playlist" action.

import { useTransition } from "react";
import Link from "next/link";
import { Heart } from "lucide-react";
import { loadPlaylistQueue } from "@/app/actions/music-state";
import { usePlayer } from "@/components/player/usePlayer";
import { PlayIcon } from "@/components/player/icons";

export function PlaylistsPanel({ favouriteTrackCount }: { favouriteTrackCount: number }) {
  const { engine } = usePlayer();
  const [pending, startTransition] = useTransition();

  function handlePlay() {
    startTransition(async () => {
      const tracks = await loadPlaylistQueue("favourites");
      engine.playTracks(tracks, { context: { kind: "favourites" } });
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-display text-xs font-semibold tracking-wide text-text-muted">Playlists</h3>

      <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-bg-hover">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pink-500/15 text-pink-400">
          <Heart aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href="/music/favourites" className="block truncate text-sm text-text hover:underline">
            Favourite tracks
          </Link>
          <p className="truncate text-xs text-text-muted">
            {favouriteTrackCount} track{favouriteTrackCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={handlePlay}
          disabled={favouriteTrackCount === 0 || pending}
          aria-label="Play favourite tracks"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-format-digital disabled:opacity-30"
        >
          <PlayIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
