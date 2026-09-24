"use client";

// A title as its own artwork — the film's or show's TMDB logo, a
// transparent PNG of the title styling on the poster — over an open Home
// card's backdrop; the plain title in the display font where there's no
// logo or it won't load. The web's TVTitleArt (MediaVaultiOS). Sized off
// the row's --row-h, as the TV sizes it off the card's height: the logo
// fits a box about the card's height wide and a third of it tall.

import { useState } from "react";

export default function TitleArt({ title, logoPath }: { title: string; logoPath: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!logoPath || failed) {
    return (
      <span className="line-clamp-2 max-w-[calc(var(--row-h)*1.05)] font-display text-[calc(var(--row-h)*0.11)] font-bold leading-tight tracking-wide text-text [text-shadow:0_2px_12px_rgba(0,0,0,0.6)]">
        {title}
      </span>
    );
  }
  return (
    <img
      src={`/api/poster/w500${logoPath}`}
      alt={title}
      decoding="async"
      className="h-auto max-h-[calc(var(--row-h)*0.3)] w-auto max-w-[calc(var(--row-h)*1.05)] object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.45)]"
      onError={() => setFailed(true)}
    />
  );
}
