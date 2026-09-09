"use client";

// The album page's action row, in the meta block beside the year/kind
// chips: a round favourite heart, same styling and optimistic-toggle-then-
// router.refresh() pattern as FilmActions' favourite button, plus a second
// button that opens the shared playlist chooser (AddToPlaylistMenu) to add
// every track on the album.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HeartMinus, HeartPlus, ListPlus } from "lucide-react";
import { toggleAlbumFavourite } from "@/app/actions/music-state";
import AddToPlaylistMenu from "@/components/player/AddToPlaylistMenu";

export default function AlbumActions({
  albumId,
  title,
  favourite: initialFavourite,
  trackIds,
}: {
  albumId: number;
  title: string;
  favourite: boolean;
  trackIds: number[];
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const iconButton =
    "inline-flex h-10 w-10 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-40";

  return (
    <>
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
              const result = await toggleAlbumFavourite(albumId);
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

      <div ref={menuContainerRef} className="relative">
        <button
          ref={menuButtonRef}
          type="button"
          disabled={trackIds.length === 0}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Add ${title} to a playlist`}
          title="Add to a playlist"
          onClick={() => setMenuOpen((o) => !o)}
          className={`${iconButton} border-border text-text-muted hover:border-accent-border hover:text-accent-bright`}
        >
          <ListPlus aria-hidden className="h-5 w-5" />
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label={`Add ${title} to a playlist`}
            className="absolute top-full right-0 z-50 mt-1 flex w-56 flex-col gap-0.5 rounded-xl border border-border bg-bg-elevated-2 p-1 shadow-lg shadow-black/50"
          >
            <AddToPlaylistMenu trackIds={trackIds} onDone={() => setMenuOpen(false)} />
          </div>
        )}
      </div>
    </>
  );
}
