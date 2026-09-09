"use client";

// The /music/favourites page's body: the Play/Shuffle header plus the track
// rows themselves. Keeps a local copy of the server-fetched list so
// TrackHeart's onChange can drop a row the instant it's un-hearted, rather
// than waiting on a full page reload. Styled like AlbumFormatTabs'
// DigitalTracklist (same divide-y/border list) and AlbumPlayBar (same
// Play/Shuffle button styles).

import { useState } from "react";
import Link from "next/link";
import { Volume2 } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import TrackHeart from "@/components/music/TrackHeart";
import TrackMenu from "@/components/player/TrackMenu";
import { PlayIcon, PauseIcon, ShuffleIcon } from "@/components/player/icons";
import { usePlayer } from "@/components/player/usePlayer";
import { formatTime } from "@/lib/format-time";
import type { PlaybackContext } from "@/lib/player-types";
import type { FavouriteTrackView } from "@/lib/queries-music";

const secondaryChip =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text";

const CONTEXT: PlaybackContext = { kind: "favourites" };

export default function FavouriteTracksView({ tracks: initialTracks }: { tracks: FavouriteTrackView[] }) {
  const [tracks, setTracks] = useState(initialTracks);
  const { snapshot, engine } = usePlayer();

  const isThisList = snapshot.context?.kind === "favourites";
  const isPlaying = isThisList && (snapshot.status === "playing" || snapshot.status === "loading");
  const isPaused = isThisList && snapshot.status === "paused";

  function handlePlayClick() {
    if (isPlaying) engine.pause();
    else if (isPaused) engine.play();
    else engine.playTracks(tracks, { context: CONTEXT });
  }

  if (tracks.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-text-faint">
        No favourite tracks yet — heart a track on any album page.{" "}
        <Link href="/music" className="text-format-digital hover:underline">
          Browse music
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
          onClick={() => engine.playTracks(tracks, { context: CONTEXT, shuffle: true })}
          aria-label="Shuffle"
          className={secondaryChip}
        >
          <ShuffleIcon className="h-3.5 w-3.5" />
          Shuffle
        </button>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
        {tracks.map((t, i) => {
          const isCurrent = snapshot.current?.trackId === t.trackId;
          return (
            <li key={t.trackId} className="group flex items-center gap-3 px-3 py-2">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-text-faint">{i + 1}</span>
              <CoverImage
                albumId={t.hasCover ? t.albumId : null}
                version={t.coverVersion}
                title={t.albumTitle}
                fallback="glyph"
                className="h-8 w-8 shrink-0 rounded"
              />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => engine.playTracks(tracks, { startIndex: i, context: CONTEXT })}
                  aria-label={`Play ${t.title}`}
                  className="flex max-w-full items-center gap-1.5 text-left text-sm hover:underline"
                >
                  {isCurrent && <Volume2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-format-digital" />}
                  <span className={`truncate ${isCurrent ? "text-format-digital" : "text-text"}`}>{t.title}</span>
                </button>
                <p className="truncate text-xs text-text-muted">
                  {t.artist} ·{" "}
                  <Link href={`/music/album/${t.albumId}`} className="hover:text-text hover:underline">
                    {t.albumTitle}
                  </Link>
                </p>
              </div>
              <TrackHeart
                trackId={t.trackId}
                title={t.title}
                favourite
                onChange={(fav) => {
                  if (!fav) setTracks((prev) => prev.filter((x) => x.trackId !== t.trackId));
                }}
              />
              <TrackMenu tracks={[t]} label={t.title} context={CONTEXT} size="sm" />
              <span className="shrink-0 font-mono text-xs text-text-faint">{formatTime(t.durationSecs)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
