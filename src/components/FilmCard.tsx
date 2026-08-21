import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import type { LibraryFilm } from "@/lib/queries";

export default function FilmCard({ film }: { film: LibraryFilm }) {
  return (
    <Link
      href={`/film/${film.id}`}
      className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <PosterImage
        posterPath={film.posterPath}
        title={film.title}
        year={film.year}
        className="aspect-2/3 w-full border-b border-border"
      />
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">
          {film.title}
        </h3>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-text-faint">{film.year ?? "—"}</span>
          {film.formats.length > 0 && (
            <div className="flex gap-1">
              {film.formats.map((f) => (
                <FormatBadge key={f} kind={f} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
