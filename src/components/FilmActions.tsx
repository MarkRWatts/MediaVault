"use client";

// The film page's action row, just above the overview: the main Play
// button, favourite (HeartPlus to add, HeartMinus in pink once it is one),
// and "reset viewed" (Eye while there is a watch record to clear, EyeOff
// once there isn't). Favourite and reset call server actions and re-render
// the page; the Play button opens the in-app player.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Eye, HeartMinus, HeartPlus } from "lucide-react";
import PlayButton from "@/components/PlayButton";
import type { PlaybackSource } from "@/components/VideoPlayer";
import { resetFilmWatched, resetShowWatched, toggleFilmFavourite, toggleShowFavourite } from "@/app/actions/film-state";

export default function FilmActions({
  filmId,
  title,
  play,
  favourite: initialFavourite,
  watched: initialWatched,
  kind = "film",
}: {
  /** Film id, or show id with kind "show". */
  filmId: number;
  title: string;
  /** null when nothing is playable in-app. For a show, `versionId` is the
   *  next episode's file id and `basePath` is "/api/tv-video". */
  play: {
    versionId: number;
    source: PlaybackSource;
    audioTracks: { streamIdx: number; label: string }[];
    basePath?: string;
    label?: string;
    playTitle?: string;
  } | null;
  favourite: boolean;
  watched: boolean;
  kind?: "film" | "show";
}) {
  const toggleFavourite = kind === "show" ? toggleShowFavourite : toggleFilmFavourite;
  const resetWatched = kind === "show" ? resetShowWatched : resetFilmWatched;
  const [favourite, setFavourite] = useState(initialFavourite);
  const [watched, setWatched] = useState(initialWatched);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const iconButton =
    "inline-flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {play && (
        <PlayButton
          versionId={play.versionId}
          title={play.playTitle ?? title}
          source={play.source}
          audioTracks={play.audioTracks}
          basePath={play.basePath}
          label={play.label}
          size="lg"
        />
      )}

      <button
        type="button"
        disabled={pending}
        aria-pressed={favourite}
        aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
        title={favourite ? "Remove from favourites" : "Add to favourites"}
        onClick={() =>
          startTransition(async () => {
            const next = !favourite;
            setFavourite(next);
            try {
              const result = await toggleFavourite(filmId);
              setFavourite(result.favourite);
              router.refresh();
            } catch {
              setFavourite(!next);
            }
          })
        }
        className={`${iconButton} ${
          favourite
            ? "border-pink-400/50 bg-pink-500/15 text-pink-400 hover:bg-pink-500/25"
            : "border-border text-text-muted hover:border-accent-border hover:text-accent-bright"
        }`}
      >
        {favourite ? <HeartMinus aria-hidden className="h-5 w-5" /> : <HeartPlus aria-hidden className="h-5 w-5" />}
      </button>

      <button
        type="button"
        disabled={pending || !watched}
        aria-label={watched ? "Reset viewed status" : "Not viewed yet"}
        title={watched ? "Viewed — click to reset your progress and watched status" : "Not viewed yet"}
        onClick={() =>
          startTransition(async () => {
            try {
              await resetWatched(filmId);
              setWatched(false);
              router.refresh();
            } catch {
              // Leave the state as it was; the page re-render is the truth.
            }
          })
        }
        className={`${iconButton} ${
          watched ? "border-accent-border text-accent-bright hover:bg-accent-bright/15" : "border-border text-text-faint"
        }`}
      >
        {watched ? <Eye aria-hidden className="h-5 w-5" /> : <EyeOff aria-hidden className="h-5 w-5" />}
      </button>
    </div>
  );
}
