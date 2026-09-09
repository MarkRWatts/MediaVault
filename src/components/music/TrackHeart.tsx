"use client";

// The heart on a track row — album tracklist, the /music/favourites list,
// (later) playlist rows. Optimistic like CardActions: flips at once, calls
// toggleTrackFavourite, settles on the server's answer, reverts on error.
// router.refresh() afterwards re-renders the Server Components that show
// counts (the /music tile, the rail's pinned row) without touching the
// player's client state.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HeartMinus, HeartPlus } from "lucide-react";
import { toggleTrackFavourite } from "@/app/actions/music-state";

export default function TrackHeart({
  trackId,
  title,
  favourite: initialFavourite,
  size = "sm",
  onChange,
}: {
  trackId: number;
  title: string;
  favourite: boolean;
  size?: "sm" | "md";
  /** Fired with the settled value — the favourites list uses it to drop a
   *  row that was just un-hearted. */
  onChange?: (favourite: boolean) => void;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const box = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={favourite}
      aria-label={favourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
      title={favourite ? "Remove from favourites" : "Add to favourites"}
      onClick={(e) => {
        e.stopPropagation();
        startTransition(async () => {
          const next = !favourite;
          setFavourite(next);
          try {
            const result = await toggleTrackFavourite(trackId);
            setFavourite(result.favourite);
            onChange?.(result.favourite);
            router.refresh();
          } catch {
            setFavourite(!next);
          }
        });
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${box} ${
        favourite ? "text-pink-400 hover:bg-pink-500/15" : "text-text-faint hover:bg-bg-hover hover:text-pink-300"
      }`}
    >
      {favourite ? <HeartMinus aria-hidden className={icon} /> : <HeartPlus aria-hidden className={icon} />}
    </button>
  );
}
