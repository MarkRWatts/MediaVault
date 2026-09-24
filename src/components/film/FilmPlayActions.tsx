"use client";

// The film page's actions (FILM_PAGE_PLAN.md "Actions"): one full-width
// amber Play — "Resume from 37:43" when there's a place to go back to, with
// a quieter "Play from the Beginning" under it — then a centred row of
// labelled icon buttons: Favourite, Watched (reset, behind a confirmation)
// and Quality, which picks the copy Play plays from a small sheet of
// plain-word labels (src/lib/copy-quality.ts). Favourite and reset call the
// same server actions the old row did; Play opens the same in-app player.
//
// The show page uses it too (SHOW_PAGE_PLAN.md "Play and actions", kind
// "show"): its one "copy" is the next episode's file, the button names the
// episode ("Resume – Season 2, Episode 8") and the player finds the position
// itself; Favourite and Watched act on the whole show.

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, Heart, MonitorPlay, Play, RotateCcw } from "lucide-react";
import VideoPlayer, { type PlaybackSource } from "@/components/VideoPlayer";
import {
  resetFilmWatched,
  resetShowWatched,
  toggleFilmFavourite,
  toggleShowFavourite,
} from "@/app/actions/film-state";
import { formatClock } from "@/lib/pending-seek";

export interface FilmCopyOption {
  versionId: number;
  /** "High Definition (Blu-ray)" — the Quality sheet's row. */
  label: string;
  /** "HD" — the caption under the Quality button. */
  shortLabel: string;
  /** Null when this copy can't play here; `disabledReason` says why. */
  source: PlaybackSource | null;
  disabledReason?: string;
  /** Where this person left off on this copy, if anywhere. */
  resumeSecs: number | null;
}

export default function FilmPlayActions({
  filmId,
  title,
  copies,
  defaultCopyId,
  playDisabledReason,
  favourite: initialFavourite,
  watched: initialWatched,
  kind = "film",
  playLabel,
  playTitle,
  basePath,
}: {
  /** The film's id, or the show's with kind "show". */
  filmId: number;
  title: string;
  /** Best first, as Quality lists them. */
  copies: FilmCopyOption[];
  defaultCopyId: number | null;
  /** With nothing playable, why — shown under a disabled Play. */
  playDisabledReason?: string;
  favourite: boolean;
  watched: boolean;
  kind?: "film" | "show";
  /** In place of "Play" / "Resume from 37:43" — the show page's "Resume – Season 2, Episode 8". */
  playLabel?: string;
  /** The player's title, when it isn't `title` ("Firefly S01E02 · The Train Job"). */
  playTitle?: string;
  /** The player's API root: "/api/tv-video" for an episode file. */
  basePath?: string;
}) {
  const toggleFavouriteAction = kind === "show" ? toggleShowFavourite : toggleFilmFavourite;
  const resetWatchedAction = kind === "show" ? resetShowWatched : resetFilmWatched;
  const router = useRouter();
  const [chosenId, setChosenId] = useState(defaultCopyId);
  const [player, setPlayer] = useState<{ fromStart: boolean } | null>(null);
  const [favourite, setFavourite] = useState(initialFavourite);
  const [watched, setWatched] = useState(initialWatched);
  const [sheet, setSheet] = useState<"quality" | "reset" | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = copies.find((c) => c.versionId === chosenId && c.source) ?? null;
  // Cleared the moment a reset succeeds rather than when the refresh lands.
  const resumeSecs = watched ? (chosen?.resumeSecs ?? null) : null;

  // Stable, so the player's start-up effect (which lists onClose) runs once.
  const closePlayer = useCallback(() => {
    setPlayer(null);
    // The new position (or "watched") is on the server now; re-read it so
    // the button says where to resume.
    router.refresh();
  }, [router]);

  function toggleFavourite() {
    startTransition(async () => {
      const next = !favourite;
      setFavourite(next);
      try {
        const result = await toggleFavouriteAction(filmId);
        setFavourite(result.favourite);
        router.refresh();
      } catch {
        setFavourite(!next);
      }
    });
  }

  function resetWatched() {
    setSheet(null);
    startTransition(async () => {
      try {
        await resetWatchedAction(filmId);
        setWatched(false);
        router.refresh();
      } catch {
        // Leave the state as it was; the page re-render is the truth.
      }
    });
  }

  const iconButton =
    "flex min-w-16 flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text disabled:opacity-40";

  return (
    <div className="flex w-full flex-col gap-3">
      {chosen ? (
        <>
          <button
            type="button"
            onClick={() => setPlayer({ fromStart: false })}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3.5 font-display text-base font-semibold text-bg transition-colors hover:bg-accent-bright"
          >
            <Play aria-hidden className="h-5 w-5 fill-current" />
            {playLabel ?? (resumeSecs !== null ? `Resume from ${formatClock(resumeSecs)}` : "Play")}
          </button>
          {resumeSecs !== null && (
            <button
              type="button"
              onClick={() => setPlayer({ fromStart: true })}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-bg-hover px-5 py-3 font-display text-sm font-semibold text-text transition-colors hover:bg-bg-elevated-2"
            >
              <RotateCcw aria-hidden className="h-4 w-4" />
              Play from the Beginning
            </button>
          )}
        </>
      ) : (
        (playDisabledReason || copies.length === 0) && (
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              disabled
              className="flex w-full cursor-default items-center justify-center gap-2 rounded-xl bg-bg-hover px-5 py-3.5 font-display text-base font-semibold text-text-faint"
            >
              <Play aria-hidden className="h-5 w-5 fill-current" />
              Play
            </button>
            {/* Said on the page, not in a tooltip: most of the household is
                on a touch screen. */}
            <p className="text-center text-xs text-text-faint">
              {playDisabledReason ??
                (kind === "show" ? "No episode of this show is on the server." : "No copy of this film is on the server.")}
            </p>
          </div>
        )
      )}

      <div className="flex items-start justify-center gap-6 pt-1">
        <button
          type="button"
          disabled={pending}
          aria-pressed={favourite}
          onClick={toggleFavourite}
          className={`${iconButton} ${favourite ? "text-pink-400 hover:text-pink-300" : ""}`}
        >
          <Heart aria-hidden className={`h-6 w-6 ${favourite ? "fill-current" : ""}`} />
          Favourite
        </button>

        {watched && (
          <button type="button" disabled={pending} onClick={() => setSheet("reset")} className={iconButton}>
            <EyeOff aria-hidden className="h-6 w-6" />
            Watched
          </button>
        )}

        {copies.length > 1 && (
          <button
            type="button"
            onClick={() => setSheet("quality")}
            aria-haspopup="dialog"
            aria-label={`Quality: ${chosen?.label ?? "choose a copy"}`}
            className={iconButton}
          >
            <MonitorPlay aria-hidden className="h-6 w-6" />
            {chosen?.shortLabel ?? "Quality"}
          </button>
        )}
      </div>

      {sheet && (
        <Sheet label={sheet === "quality" ? "Quality" : "Reset watch status"} onClose={() => setSheet(null)}>
          {sheet === "quality" ? (
            <>
              <h2 className="px-2 pb-1 font-display text-lg font-semibold text-text">Quality</h2>
              <ul className="flex flex-col">
                {copies.map((c) => {
                  const selected = c.versionId === chosen?.versionId;
                  return (
                    <li key={c.versionId}>
                      <button
                        type="button"
                        disabled={!c.source}
                        aria-pressed={selected}
                        onClick={() => {
                          setChosenId(c.versionId);
                          setSheet(null);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className={`text-sm ${c.source ? "text-text" : "text-text-faint"}`}>{c.label}</span>
                          {!c.source && c.disabledReason && (
                            <span className="text-xs text-text-faint">{c.disabledReason}</span>
                          )}
                        </span>
                        {selected && <Check aria-hidden className="h-5 w-5 shrink-0 text-accent" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="flex flex-col gap-4 px-2 pb-1">
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-lg font-semibold text-text">Reset watch status?</h2>
                <p className="text-sm text-text-muted">
                  {kind === "show"
                    ? `Forgets where you got to in every episode of ${title} and marks them all as not watched.`
                    : `Forgets where you got to in ${title} and marks it as not watched.`}{" "}
                  Your viewing history stays.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSheet(null)}
                  className="flex-1 rounded-xl bg-bg-hover px-4 py-3 text-sm font-semibold text-text transition-colors hover:bg-bg-elevated-2"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={resetWatched}
                  className="flex-1 rounded-xl border border-missing-border px-4 py-3 text-sm font-semibold text-missing transition-colors hover:bg-missing-bg"
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </Sheet>
      )}

      {player && chosen?.source && (
        <VideoPlayer
          versionId={chosen.versionId}
          title={playTitle ?? title}
          source={chosen.source}
          basePath={basePath}
          fromStart={player.fromStart}
          onClose={closePlayer}
        />
      )}
    </div>
  );
}

/** A small sheet: slides up from the bottom on a phone, a centred card on a
 *  wider screen. Tapping outside or Escape closes it. */
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      // z-[55]: above the shell's tab bar (z-40) and menus (z-50), below
      // the video player (z-[60]).
      className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center sm:px-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-2xl border border-border bg-bg-elevated-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg shadow-black/50 sm:rounded-2xl sm:pb-3"
      >
        {children}
      </div>
    </div>
  );
}
