"use client";

// Square album/artist cover art, modelled on PosterImage. Unlike posters
// (served by relative TMDB path), covers are keyed by the numeric Album id —
// see src/app/api/cover/[albumId]/route.ts — so callers pass an albumId
// (null when there's no cached art, e.g. a missing back-catalogue album or
// an artist with no owned album that has cover art yet) rather than a path.
// Bakes in aspect-square (cover art is always 1:1, unlike film posters where
// the app leaves the ratio to the caller).
//
// A plain <img>, not next/image — see PosterImage for why.

import { useState } from "react";
import { Disc3 } from "lucide-react";

export default function CoverImage({
  albumId,
  version,
  title,
  priority = false,
  className = "",
  src,
  fallback = "title",
}: {
  albumId: number | null;
  /** Cover cache-buster (queries' coverVersion). A cover's bytes can change
   *  under the same /api/cover/<id> URL and the browser caches per URL —
   *  versioning the URL is what actually invalidates it. */
  version?: number | null;
  title: string;
  /** Accepted for compatibility; no longer used without next/image. */
  sizes?: string;
  priority?: boolean;
  className?: string;
  /** Explicit image URL, overriding the default /api/cover/<albumId> — used
   *  for a physical pressing's own cover art (/api/physical-cover/<copyId>,
   *  a different route keyed by PhysicalCopy id rather than Album id). */
  src?: string | null;
  /** What to draw when there's no art: the title (default — fine at card
   *  size) or a disc glyph for thumbnails too small to fit any words (the
   *  rail's strip and queue rows, the mobile player strip). */
  fallback?: "title" | "glyph";
}) {
  const [errored, setErrored] = useState(false);
  const resolvedSrc = src ?? (albumId != null ? `/api/cover/${albumId}${version != null ? `?v=${version}` : ""}` : null);
  const showFallback = resolvedSrc == null || errored;

  return (
    <div className={`relative aspect-square overflow-hidden bg-bg-elevated-2 ${className}`}>
      {showFallback && fallback === "glyph" ? (
        <div className="absolute inset-0 flex items-center justify-center text-text-faint">
          <Disc3 aria-hidden className="h-1/2 w-1/2" />
        </div>
      ) : showFallback ? (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-center">
          <span className="font-display text-balance text-sm leading-[1.05] tracking-wide text-text-faint line-clamp-4">
            {title}
          </span>
        </div>
      ) : (
        <img
          src={resolvedSrc}
          alt={`${title} cover art`}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}
