"use client";

// A title as its own artwork — the film's or show's TMDB logo, a
// transparent PNG of the title styling on the poster — over an open Home
// card's backdrop; the plain title in the display font where there's no
// logo or it won't load. The web's TVTitleArt (MediaVaultiOS). Sized off
// the row's --row-h, as the TV sizes it off the card's height: the logo
// fits a box about the card's height wide and a third of it tall.
//
// The film page's hero uses it too (variant "hero"): centred over the
// backdrop's fade, at most ~70% of the width and 120px tall, with the
// fallback title as the page's heading (FILM_PAGE_PLAN.md).

import { useState } from "react";

export default function TitleArt({
  title,
  logoPath,
  variant = "row",
}: {
  title: string;
  logoPath: string | null;
  variant?: "row" | "hero";
}) {
  const [failed, setFailed] = useState(false);
  const hero = variant === "hero";

  if (!logoPath || failed) {
    return hero ? (
      <h1 className="max-w-[85%] text-center font-display text-4xl font-bold leading-tight text-balance text-text [text-shadow:0_2px_16px_rgba(0,0,0,0.7)] sm:text-5xl">
        {title}
      </h1>
    ) : (
      <span className="line-clamp-2 max-w-[calc(var(--row-h)*1.05)] font-display text-[calc(var(--row-h)*0.11)] font-bold leading-tight tracking-wide text-text [text-shadow:0_2px_12px_rgba(0,0,0,0.6)]">
        {title}
      </span>
    );
  }
  const img = (
    <img
      src={`/api/poster/w500${logoPath}`}
      alt={title}
      decoding="async"
      fetchPriority={hero ? "high" : undefined}
      className={
        hero
          ? "h-auto max-h-[120px] w-auto max-w-[70%] object-contain drop-shadow-[0_2px_16px_rgba(0,0,0,0.5)]"
          : "h-auto max-h-[calc(var(--row-h)*0.3)] w-auto max-w-[calc(var(--row-h)*1.05)] object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.45)]"
      }
      onError={() => setFailed(true)}
    />
  );
  // The logo is the page's title, so it stands in for the heading.
  return hero ? <h1 className="flex w-full justify-center">{img}</h1> : img;
}
