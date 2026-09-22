// The Films shelf under a show's seasons: the films someone linked to this
// show by hand (Serenity under Firefly). Ordinary FilmCards, so a film looks
// and behaves here exactly as it does on the Movies grid — it is still
// listed there too; this is an extra way to reach it, not a move.

import FilmCard from "@/components/FilmCard";
import type { LibraryFilm } from "@/lib/queries";

/** Renders nothing when nothing is linked — most shows have no films, and
 *  an empty shelf would be a heading asking a question nobody asked. */
export default function ShowFilmsSection({ films }: { films: LibraryFilm[] }) {
  if (films.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 border-b border-border pb-2">
        <h2 className="font-display text-xl tracking-wide">Films</h2>
        <span className="font-mono text-xs text-text-faint">
          {films.length} film{films.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5 @5xl:grid-cols-6">
        {films.map((f) => (
          <FilmCard key={f.id} film={f} />
        ))}
      </div>
    </section>
  );
}
