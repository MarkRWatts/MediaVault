"use client";

// The artist page's action row, beside the <h1>: a round favourite heart,
// same styling and optimistic-toggle-then-router.refresh() pattern as
// FilmActions' favourite button. No play button here — an artist has no
// single queue of its own (studio catalogue vs. shelf), unlike a film or
// an album.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HeartMinus, HeartPlus } from "lucide-react";
import { toggleArtistFavourite } from "@/app/actions/music-state";

export default function ArtistActions({
  artistId,
  name,
  favourite: initialFavourite,
}: {
  artistId: number;
  name: string;
  favourite: boolean;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const iconButton =
    "inline-flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-40";

  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={favourite}
      aria-label={favourite ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      title={favourite ? "Remove from favourites" : "Add to favourites"}
      onClick={() =>
        startTransition(async () => {
          const next = !favourite;
          setFavourite(next);
          try {
            const result = await toggleArtistFavourite(artistId);
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
  );
}
