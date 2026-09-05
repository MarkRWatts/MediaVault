import FilmCard from "@/components/FilmCard";
import SectionHeader from "@/components/SectionHeader";
import type { LibraryFilm } from "@/lib/queries";
import { SHELF_ITEM } from "@/lib/card-grid";

// Horizontal-scrolling highlight row (Continue watching / New releases /
// Recently added / Favourites) — always a flat list of individual films,
// independent of the browse grid's filters. Cards are the same size as the
// grid's: an ancestor sets `--cards` (see src/lib/card-grid.ts) and each
// item takes one column's width, so the same number show across.
// Collapsible like the grid's sections; the parent owns the state.
export default function FilmShelf({
  title,
  films,
  collapsed = false,
  onToggle,
}: {
  title: string;
  films: LibraryFilm[];
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  if (films.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={title} count={films.length} collapsed={collapsed} onToggle={onToggle ?? (() => {})} />
      {!collapsed && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {films.map((film) => (
            <div key={film.id} className={SHELF_ITEM}>
              <FilmCard film={film} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
