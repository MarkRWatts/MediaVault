"use client";

// The favourite / reset-viewed overlay in a film card's top-right corner.
// Same server actions as the film page's FilmActions; kept outside the
// card's Link so a click here never navigates. The heart is always shown
// (pink HeartMinus once favourited, so favourites read at a glance); the
// eye appears only while there is a watch record to clear.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, HeartMinus, HeartPlus } from "lucide-react";
import { resetFilmWatched, toggleFilmFavourite } from "@/app/actions/film-state";

export interface CardState {
  favourite: boolean;
  watched: boolean;
}

export default function CardActions({ filmId, title, state }: { filmId: number; title: string; state: CardState }) {
  const [favourite, setFavourite] = useState(state.favourite);
  const [watched, setWatched] = useState(state.watched);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const button =
    "inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-sm transition-colors disabled:opacity-50";

  return (
    <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
      {watched && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Reset viewed status for ${title}`}
          title="Viewed — click to reset your progress and watched status"
          onClick={() =>
            startTransition(async () => {
              try {
                await resetFilmWatched(filmId);
                setWatched(false);
                router.refresh();
              } catch {
                // Leave as is; the next render is the truth.
              }
            })
          }
          className={`${button} border-white/20 bg-black/55 text-white/85 hover:bg-black/75`}
        >
          <Eye aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        aria-pressed={favourite}
        aria-label={favourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
        title={favourite ? "Remove from favourites" : "Add to favourites"}
        onClick={() =>
          startTransition(async () => {
            const next = !favourite;
            setFavourite(next);
            try {
              const result = await toggleFilmFavourite(filmId);
              setFavourite(result.favourite);
              router.refresh();
            } catch {
              setFavourite(!next);
            }
          })
        }
        className={`${button} ${
          favourite
            ? "border-pink-400/60 bg-pink-500/30 text-pink-300 hover:bg-pink-500/45"
            : "border-white/20 bg-black/55 text-white/85 hover:bg-black/75"
        }`}
      >
        {favourite ? <HeartMinus aria-hidden className="h-3.5 w-3.5" /> : <HeartPlus aria-hidden className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
