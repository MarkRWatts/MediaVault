"use client";

// A plain <img>, not next/image: the optimizer fetched sources server-side
// with none of the browser's cookies, which forced /api/poster to be public.
// TMDB already serves posters at the sizes the cards need (w342 for grids,
// w780 for hero art), so nothing is lost by skipping it. `sizes` is still
// accepted from callers for compatibility but no longer means anything.

import { useState } from "react";
import NoPoster from "@/components/NoPoster";

export default function PosterImage({
  posterPath,
  title,
  year,
  size = "w342",
  priority = false,
  className = "",
}: {
  posterPath: string | null;
  title: string;
  year?: number | null;
  size?: "w342" | "w780";
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const showFallback = !posterPath || errored;

  return (
    <div className={`relative overflow-hidden bg-bg-elevated ${className}`}>
      {showFallback ? (
        <NoPoster title={title} year={year} />
      ) : (
        <img
          src={`/api/poster/${size}${posterPath}`}
          alt={`${title} poster`}
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
