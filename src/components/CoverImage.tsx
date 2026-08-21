"use client";

// Square album/artist cover art, modelled on PosterImage. Unlike posters
// (served by relative TMDB path), covers are keyed by the numeric Album id —
// see src/app/api/cover/[albumId]/route.ts — so callers pass an albumId
// (null when there's no cached art, e.g. a missing back-catalogue album or
// an artist with no owned album that has cover art yet) rather than a path.
// Bakes in aspect-square (cover art is always 1:1, unlike film posters where
// the app leaves the ratio to the caller).

import { useState } from "react";
import Image from "next/image";

export default function CoverImage({
  albumId,
  title,
  sizes,
  priority = false,
  className = "",
}: {
  albumId: number | null;
  title: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const showFallback = albumId == null || errored;

  return (
    <div className={`relative aspect-square overflow-hidden bg-bg-elevated-2 ${className}`}>
      {showFallback ? (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-center">
          <span className="font-display text-balance text-sm leading-[1.05] tracking-wide text-text-faint line-clamp-4">
            {title}
          </span>
        </div>
      ) : (
        <Image
          src={`/api/cover/${albumId}`}
          alt={`${title} cover art`}
          fill
          sizes={sizes ?? "(min-width: 1280px) 160px, (min-width: 640px) 20vw, 40vw"}
          priority={priority}
          className="object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}
