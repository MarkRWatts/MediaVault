import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import type { LibraryFilm } from "@/lib/queries";

// One card representing a whole collection on the dashboard grid — used when
// "Stack collections" is on. Shows the chronologically-earliest poster with a
// stacked-card affordance and links through to the collection timeline.
export default function StackedFilmCard({
  collectionId,
  collectionName,
  films,
}: {
  collectionId: number;
  collectionName: string;
  films: LibraryFilm[];
}) {
  const [first] = films;

  return (
    <Link
      href={`/collections/${collectionId}`}
      className="hover-lift group relative flex flex-col"
    >
      <div className="relative aspect-2/3 w-full">
        {/* Offset back cards create the stacked-deck look. */}
        <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg border border-border bg-bg-elevated-2" />
        <div className="absolute inset-0 translate-x-0.5 translate-y-0.5 rounded-lg border border-border bg-bg-elevated" />
        <div className="absolute inset-0 overflow-hidden rounded-lg border border-border">
          <PosterImage
            posterPath={first.posterPath}
            title={first.title}
            year={first.year}
            className="h-full w-full"
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-2 pt-6">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-white/90">
              {films.length} films
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">
          {collectionName}
        </h3>
        <span className="font-mono text-xs text-text-faint">
          {first.year ?? "—"}
          {films.length > 1 && films[films.length - 1].year
            ? `–${films[films.length - 1].year}`
            : ""}
        </span>
      </div>
    </Link>
  );
}
