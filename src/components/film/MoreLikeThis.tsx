// The film page's closing row (FILM_PAGE_PLAN.md "More like this"): the
// rest of its collection in release order, then films sharing its genres —
// see getMoreLikeThis. Posters only, scrolled sideways; tap to open.

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import type { SimilarFilm } from "@/lib/queries";

export default function MoreLikeThis({ films }: { films: SimilarFilm[] }) {
  if (films.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-4 font-display text-xl font-semibold sm:px-6">More like this</h2>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:px-6">
        {films.map((f) => (
          <Link
            key={f.id}
            href={`/film/${f.id}`}
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
