import FilmCard from "@/components/FilmCard";
import type { LibraryFilm } from "@/lib/queries";

// Horizontal-scrolling highlight row (New releases / Recently added) — always
// a flat list of individual films, independent of the browse grid's filters.
// Cards are ~25% smaller than the grid's (fixed width vs. the grid's
// responsive columns, since a scrolling shelf doesn't need to reflow).
export default function FilmShelf({ title, films }: { title: string; films: LibraryFilm[] }) {
  if (films.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg tracking-wide">{title}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {films.map((film) => (
          <div key={film.id} className="w-28 shrink-0 sm:w-32">
            <FilmCard film={film} compact />
          </div>
        ))}
      </div>
    </section>
  );
}
