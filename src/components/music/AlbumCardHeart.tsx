"use client";

// The favourite heart in an album card's top-right corner — the music
// counterpart of CardActions' heart on film/show cards: same glass pill,
// pink HeartMinus once favourited, optimistic toggle via
// toggleAlbumFavourite, then router.refresh() so the /music shelves and
// the rail's counts catch up. The card's Link wraps the whole tile, so the
// click is stopped (and its default prevented) here, never navigating.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HeartMinus, HeartPlus } from "lucide-react";
import { toggleAlbumFavourite } from "@/app/actions/music-state";

export default function AlbumCardHeart({
  albumId,
  title,
  favourite: initialFavourite,
}: {
  albumId: number;
  title: string;
  favourite: boolean;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={favourite}
      aria-label={favourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
      title={favourite ? "Remove from favourites" : "Add to favourites"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        startTransition(async () => {
          const next = !favourite;
          setFavourite(next);
          try {
            const result = await toggleAlbumFavourite(albumId);
            setFavourite(result.favourite);
            router.refresh();
          } catch {
            setFavourite(!next);
          }
        });
      }}
      className={`absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-sm transition-colors disabled:opacity-50 ${
        favourite
          ? "border-pink-400/60 bg-pink-500/30 text-pink-300 hover:bg-pink-500/45"
          : "border-white/20 bg-black/55 text-white/85 hover:bg-black/75"
      }`}
    >
      {favourite ? <HeartMinus aria-hidden className="h-3.5 w-3.5" /> : <HeartPlus aria-hidden className="h-3.5 w-3.5" />}
    </button>
  );
}
