import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import PhysicalOnlyBadge from "@/components/PhysicalOnlyBadge";
import type { LibraryFilm } from "@/lib/queries";

export default function FilmCard({
  film,
  compact = false,
}: {
  film: LibraryFilm;
  compact?: boolean;
}) {
  // A disc you've logged but never ripped: no Version rows (so film.formats
  // is empty), just a FilmPhysicalCopy. Falls back to the physical medium so
  // it still gets a format chip instead of showing nothing.
  const isPhysicalOnly = !film.owned && film.physicalMedia.length > 0;
  const formatChips = (film.formats.length > 0 ? film.formats : film.physicalMedia).slice(0, 3);

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
          className={`line-clamp-2 font-semibold leading-snug text-text ${compact ? "min-h-[2lh] text-xs" : "text-sm"}`}
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
              {isPhysicalOnly && <PhysicalOnlyBadge />}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
