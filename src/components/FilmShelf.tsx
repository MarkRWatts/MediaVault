import FilmCard from "@/components/FilmCard";
import type { LibraryFilm } from "@/lib/queries";
import { SHELF_ITEM } from "@/lib/card-grid";

// Horizontal-scrolling highlight row (Continue watching / New releases /
// Recently added / Favourites) — always a flat list of individual films,
// independent of the browse grid's filters. Cards are the same size as the
// grid's: an ancestor sets `--cards` (see src/lib/card-grid.ts) and each
// item takes one column's width, so the same number show across.
export default function FilmShelf({ title, films }: { title: string; films: LibraryFilm[] }) {
  if (films.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg tracking-wide">{title}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {films.map((film) => (
          <div key={film.id} className={SHELF_ITEM}>
            <FilmCard film={film} />
          </div>
        ))}
      </div>
    </section>
  );
}
