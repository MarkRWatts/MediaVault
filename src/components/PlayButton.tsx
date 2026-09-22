"use client";

// Small client island so a server component (VersionCard, the film page's
// action row) can open the in-app player without becoming "use client".

import { useState } from "react";
import { Play } from "lucide-react";
import VideoPlayer, { type PlaybackSource } from "@/components/VideoPlayer";

export default function PlayButton({
  versionId,
  title,
  source = "local",
  audioTracks,
  size = "sm",
  basePath,
  label = "Play",
  disabledReason,
}: {
  /** Version id for films; EpisodeFile id with basePath "/api/tv-video". */
  versionId: number;
  title: string;
  source?: PlaybackSource;
  audioTracks?: { streamIdx: number; label: string }[];
  /** "sm" is the per-version chip, "lg" the film/show page's main button,
   *  and "overlay" covers a piece of artwork entirely — the episode still,
   *  where the play control is the image itself rather than a pill beside
   *  it. The caller positions it inside a `relative` box. */
  size?: "sm" | "lg" | "overlay";
  basePath?: string;
  label?: string;
  /** Why this can't be played — renders the button disabled and says so
   *  beside it instead of opening the player. The server refuses these
   *  anyway (see src/lib/uhd-gate.ts); this is so the viewer isn't led into
   *  an error. */
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);

  const className =
    size === "overlay"
      ? "group absolute inset-0 flex items-center justify-center bg-bg/30 transition-colors hover:bg-bg/55 focus-visible:bg-bg/55"
      : size === "lg"
        ? "inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-bright/15 px-5 py-2.5 text-sm font-semibold tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/25 disabled:cursor-default disabled:border-border disabled:bg-transparent disabled:text-text-faint"
        : "inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bright/10 px-2.5 py-1 text-[11px] font-medium tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/20 disabled:cursor-default disabled:border-border disabled:bg-transparent disabled:text-text-faint";

  if (disabledReason && size !== "overlay") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" disabled title={disabledReason} className={className}>
          <Play aria-hidden className={size === "lg" ? "h-4 w-4 fill-current" : "h-2.5 w-2.5 fill-current"} />
          {label}
        </button>
        {/* A title alone is invisible on a touch screen, which is most of
            the household — the reason has to be on the page. */}
        <span className="text-[11px] text-text-faint">{disabledReason}</span>
      </span>
    );
  }

  if (size === "overlay") {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} title={`Play ${title}`} className={className}>
          {/* Always visible rather than hover-only: on a touch screen there
              is no hover, and the still would look like a plain thumbnail. */}
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-text/50 bg-bg/45 text-text transition-colors group-hover:border-accent-bright group-hover:text-accent-bright">
            <Play aria-hidden className="ml-0.5 h-4 w-4 fill-current" />
          </span>
          <span className="sr-only">{label}</span>
        </button>
        {open && (
          <VideoPlayer
            versionId={versionId}
            title={title}
            source={source}
            audioTracks={audioTracks}
            basePath={basePath}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={`Play ${title}`} className={className}>
        <Play aria-hidden className={size === "lg" ? "h-4 w-4 fill-current" : "h-2.5 w-2.5 fill-current"} />
        {label}
      </button>
      {open && (
        <VideoPlayer
          versionId={versionId}
          title={title}
          source={source}
          audioTracks={audioTracks}
          basePath={basePath}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
