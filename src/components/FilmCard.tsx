import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import type { LibraryFilm } from "@/lib/queries";

export default function FilmCard({
  film,
  compact = false,
}: {
  film: LibraryFilm;
  compact?: boolean;
}) {
  const formatChips = film.formats.slice(0, 3);

  return (
    <Link
      href={`/film/${film.id}`}
      className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <PosterImage
        posterPath={film.posterPath}
        title={film.title}
        year={film.year}
        sizes={compact ? "140px" : undefined}
        className="aspect-2/3 w-full border-b border-border"
      />
      <div className={`flex flex-1 flex-col gap-1.5 ${compact ? "p-1.5" : "p-2.5"}`}>
        <h3
          className={`line-clamp-2 font-semibold leading-snug text-text ${compact ? "text-xs" : "text-sm"}`}
        >
          {film.title}
        </h3>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className={`font-mono text-text-faint ${compact ? "text-[10px]" : "text-xs"}`}>
            {film.year ?? "—"}
          </span>
          {formatChips.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {formatChips.map((f) => (
                <FormatBadge key={f} kind={f} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
