"use client";

import { useState } from "react";

// The 2x2 montage of member posters that stands in for a collection with no
// TMDB poster of its own. Shared by CollectionCard (the /collections grid)
// and StackedFilmCard (the Movies page's stacked deck) so the same
// collection looks the same in both places.

function CollageCell({ posterPath }: { posterPath: string | null }) {
  const [errored, setErrored] = useState(false);
  if (!posterPath || errored) {
    return <div className="h-full w-full bg-bg-elevated-2" />;
  }
  return (
    <div className="relative h-full w-full">
      <img
        src={`/api/poster/w342${posterPath}`}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
        onError={() => setErrored(true)}
      />
    </div>
  );
}

export default function PosterCollage({ posters }: { posters: (string | null)[] }) {
  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-border">
      {[0, 1, 2, 3].map((i) => (
        <CollageCell key={i} posterPath={posters[i] ?? null} />
      ))}
    </div>
  );
}
