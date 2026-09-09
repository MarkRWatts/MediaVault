"use client";

// Album page's play controls — Play/Pause, Shuffle, Play next, Add to
// queue for the album's own tracklist. Used to be the top row of
// AlbumPlayer's inline transport strip; now the engine lives outside the
// page (PlayerProvider, mounted by the shell), so this is just a thin
// dispatcher onto it plus a read of its snapshot to know whether IT happens
// to be this album right now.

import { ListPlus, ListStart } from "lucide-react";
import { usePlayer } from "./player/usePlayer";
import { PauseIcon, PlayIcon, ShuffleIcon } from "./player/icons";
import type { PlaybackContext, QueueTrack } from "@/lib/player-types";

const secondaryChip =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text";

export default function AlbumPlayBar({
  queueTracks,
  context,
}: {
  queueTracks: QueueTrack[];
  context: PlaybackContext;
}) {
  const { snapshot, engine } = usePlayer();

  if (queueTracks.length === 0) return null;

  const isThisAlbum =
    context.kind === "album" && snapshot.context?.kind === "album" && snapshot.context.albumId === context.albumId;
  const isPlaying = isThisAlbum && (snapshot.status === "playing" || snapshot.status === "loading");
  const isPaused = isThisAlbum && snapshot.status === "paused";

  function handlePlayClick() {
    if (isPlaying) engine.pause();
    else if (isPaused) engine.play();
    else engine.playTracks(queueTracks, { context });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handlePlayClick}
        aria-label={isPlaying ? "Pause" : "Play"}
        className="inline-flex items-center gap-2 rounded-full border border-format-digital-border bg-format-digital-bg px-5 py-2.5 text-sm font-semibold tracking-wide text-format-digital transition-colors hover:bg-format-digital/25"
      >
        {isPlaying ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
        {isPlaying ? "Pause" : "Play"}
      </button>

      <button
        type="button"
        onClick={() => engine.playTracks(queueTracks, { context, shuffle: true })}
        aria-label="Shuffle"
        className={secondaryChip}
      >
        <ShuffleIcon className="h-3.5 w-3.5" />
        Shuffle
      </button>

      <button
        type="button"
        onClick={() => engine.playNext(queueTracks, context)}
        aria-label="Play next"
        className={secondaryChip}
      >
        <ListStart aria-hidden className="h-3.5 w-3.5" />
        Play next
      </button>

      <button
        type="button"
        onClick={() => engine.addToQueue(queueTracks, context)}
        aria-label="Add to queue"
        className={secondaryChip}
      >
        <ListPlus aria-hidden className="h-3.5 w-3.5" />
        Add to queue
      </button>
    </div>
  );
}
