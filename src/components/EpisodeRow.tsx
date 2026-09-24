"use client";

// One episode on the show page (SHOW_PAGE_PLAN.md "Episode rows"): a still
// you press to play — an amber bar along its foot when you're partway, a
// tick once you've watched it — then "1. Children of the Gods", how long it
// runs and when it would finish, and two lines of what it's about. Tapping
// the row's text (not the still) opens the rest of the synopsis. Nothing
// technical: no resolution, codec or disc — the page's chips say what's
// true of every episode and that's all anyone needs.
//
// The play control sits on the still rather than beside the title: it's the
// largest target in the row, it's where the eye already is, and it leaves
// the text column to read as text.
//
// Everything that needs the server — which file plays, whether it can play
// here at all (isFilePlayable reads the server's playback flag), how far
// through you are — arrives worked out, as an EpisodeRowItem.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import EndsAt from "@/components/EndsAt";
import PlayButton from "@/components/PlayButton";

export interface EpisodeRowItem {
  id: number;
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  runtimeMins: number | null;
  /** "46m", "1h 06m" — formatted on the server with the rest of the app's. */
  runtimeLabel: string | null;
  /** The file the still plays, or null when none of them can play here. */
  play: { fileId: number; title: string } | null;
  /** How far through (0–1) when partway, for the bar; null otherwise. */
  progress: number | null;
  watched: boolean;
  /** A multi-cut episode's other playable files — theatrical and extended
   *  rips of the same episode — which the still can't stand for, named in
   *  plain words ("High Definition (Blu-ray)"). */
  extras: { fileId: number; label: string }[];
}

const TV_VIDEO = "/api/tv-video";

export default function EpisodeRow({ episode }: { episode: EpisodeRowItem }) {
  const { episodeNumber, name, overview, stillPath, runtimeMins, runtimeLabel, play, progress, watched, extras } =
    episode;
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  // The bar and the tick are the server's to say; re-read them once the
  // player has reported where it stopped. Stable, so the player's start-up
  // effect runs once.
  const refresh = useCallback(() => router.refresh(), [router]);
  const title = `${episodeNumber}. ${name || `Episode ${episodeNumber}`}`;

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-3 sm:gap-4">
        {/* Reserved even with no artwork, so the text columns line up down
            the list and a missing still doesn't reflow the row. */}
        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-md border border-border bg-bg-elevated-2 sm:w-44">
          {stillPath && (
            <img
              src={`/api/poster/w300${stillPath}`}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {play && (
            <PlayButton
              versionId={play.fileId}
              title={play.title}
              source="jellyfin"
              basePath={TV_VIDEO}
              size="overlay"
              label={`Play ${play.title}`}
              onClosed={refresh}
            />
          )}
          {progress !== null && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div className="h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {watched && (
            <span
              title="Watched"
              className="pointer-events-none absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-bg shadow shadow-black/40"
            >
              <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={3} />
              <span className="sr-only">Watched</span>
            </span>
          )}
        </div>

        <button
          type="button"
          aria-expanded={overview ? expanded : undefined}
          disabled={!overview}
          onClick={() => setExpanded((e) => !e)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 pt-0.5 text-left disabled:cursor-default"
        >
          <span className="text-sm font-medium text-text">{title}</span>
          {(runtimeLabel || (play && runtimeMins !== null)) && (
            <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-faint">
              {runtimeLabel && <span>{runtimeLabel}</span>}
              {play && runtimeMins !== null && (
                <>
                  <span aria-hidden>·</span>
                  <EndsAt mins={runtimeMins} />
                </>
              )}
            </span>
          )}
          {overview && (
            <span
              className={`hidden text-xs leading-relaxed text-text-muted sm:block ${expanded ? "" : "line-clamp-2"}`}
            >
              {overview}
            </span>
          )}
        </button>
      </div>

      {/* On a phone the synopsis runs under the still and the title, the
          row's full width, as Netflix's does — beside a 128px still it
          would be a column a few words wide. */}
      {overview && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className={`text-left text-xs leading-relaxed text-text-muted sm:hidden ${expanded ? "" : "line-clamp-2"}`}
        >
          {overview}
        </button>
      )}

      {extras.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 sm:pl-48">
          <span className="text-xs text-text-faint">Also:</span>
          {extras.map((f) => (
            <PlayButton
              key={f.fileId}
              versionId={f.fileId}
              title={play?.title ?? title}
              source="jellyfin"
              basePath={TV_VIDEO}
              label={f.label}
              onClosed={refresh}
            />
          ))}
        </div>
      )}
    </li>
  );
}
