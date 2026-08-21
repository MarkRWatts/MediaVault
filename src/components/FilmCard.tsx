import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import type { LibraryFilm } from "@/lib/queries";

export default function FilmCard({ film }: { film: LibraryFilm }) {
  // Max ~3 chips per card: leave one slot for the resolution badge (when the
  // film has any scanned versions) and cap the disc-format chips to fill the
  // rest, deduped.
  const showTier = film.discCount > 0;
  const formatChips = film.formats.slice(0, showTier ? 2 : 3);

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
          {(formatChips.length > 0 || showTier) && (
            <div className="flex flex-wrap justify-end gap-1">
              {formatChips.map((f) => (
                <FormatBadge key={f} kind={f} />
              ))}
              {showTier && <ResolutionBadge tier={film.bestTier} />}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
