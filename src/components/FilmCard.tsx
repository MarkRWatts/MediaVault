import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import CardActions, { type CardState } from "@/components/CardActions";
import CertificationBadge, { BBFC_CARD_ICON_HEIGHT } from "@/components/CertificationBadge";
import type { LibraryFilm } from "@/lib/queries";

export default function FilmCard({
  film,
  compact = false,
  state,
}: {
  film: LibraryFilm;
  compact?: boolean;
  /** The viewer's favourite/watched state for this film; when given, the
   *  card shows the CardActions overlay in its top-right corner. */
  state?: CardState;
}) {
  // A disc you've logged but never ripped: no Version rows (so film.formats
  // is empty), just a FilmPhysicalCopy. Falls back to the physical medium so
  // it still gets a format chip instead of showing nothing.
  const formatChips = (
    film.formats.length > 0 ? film.formats : film.physicalMedia
  ).slice(0, 3);

  return (
    <div className="relative h-full">
      {state && (
        <CardActions filmId={film.id} title={film.title} state={state} />
      )}
      <Link
        href={`/film/${film.id}`}
        className="hover-lift group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
      >
        <PosterImage
          posterPath={film.posterPath}
          title={film.title}
          year={film.year}
          sizes={compact ? "140px" : undefined}
          className="aspect-2/3 w-full border-b border-border"
        />
        <div
          className={`flex flex-1 flex-col gap-1.5 ${compact ? "p-1.5" : "p-2.5"}`}
        >
          {/* Two lines of title always, so every card in a row is the same height; longer titles clip to an ellipsis with the full title in the tooltip. */}
          <h3
            title={film.title}
            className={`line-clamp-2 min-h-[2lh] font-semibold leading-snug text-text ${compact ? "text-xs" : "text-sm"}`}
          >
            {film.title}
          </h3>
          <div className="mt-auto flex items-center justify-between gap-2">
            <span
              className={`flex items-center gap-1.5 font-mono text-text-faint ${compact ? "text-[10px]" : "text-xs"}`}
            >
              <CertificationBadge certification={film.certification} height={BBFC_CARD_ICON_HEIGHT} />
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
    </div>
  );
}
