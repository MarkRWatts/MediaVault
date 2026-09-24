// The film and show pages' closing rows of posters, scrolled sideways, tap to
// open. On a film page it's More like this (FILM_PAGE_PLAN.md): the rest of
// its collection in release order, then films sharing its genres — see
// getMoreLikeThis. A show page has two (SHOW_PAGE_PLAN.md "Below the
// episodes"): Films, the ones linked to the show, then More like this, shows
// sharing its genres — see similarShows.

import Link from "next/link";
import PosterImage from "@/components/PosterImage";

export interface PosterRowItem {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export default function MoreLikeThis({
  items,
  heading = "More like this",
  kind = "film",
}: {
  items: PosterRowItem[];
  heading?: string;
  /** What the posters open: a film's page or a show's. */
  kind?: "film" | "show";
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-4 font-display text-xl font-semibold sm:px-6">{heading}</h2>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:px-6">
        {items.map((f) => (
          <Link
            key={f.id}
            href={kind === "show" ? `/shows/${f.id}` : `/film/${f.id}`}
            title={f.year ? `${f.title} (${f.year})` : f.title}
            className="w-28 shrink-0 snap-start sm:w-32"
          >
            <PosterImage
              posterPath={f.posterPath}
              title={f.title}
              year={f.year}
              className="aspect-2/3 w-full rounded-lg border border-border transition-colors hover:border-accent-border"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
