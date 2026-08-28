import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import PhysicalOnlyBadge from "@/components/PhysicalOnlyBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import type { TimelineFilm } from "@/lib/queries";

export default function TimelineFilmRow({ film }: { film: TimelineFilm }) {
  const isPhysicalOnly = !film.owned && film.physicalMedia.length > 0;
  const isPresent = film.owned || isPhysicalOnly; // has it, digitally or on disc

  const content = (
    <div
      className={`flex items-center gap-4 rounded-lg border p-3 transition-colors ${
        isPresent
          ? "border-border bg-bg-elevated hover:border-border-strong"
          : "border-border/60 bg-bg-elevated/50"
      }`}
    >
      <PosterImage
        posterPath={film.posterPath}
        title={film.title}
        year={film.year}
        sizes="64px"
        className={`aspect-2/3 w-14 shrink-0 rounded ${
          isPresent ? "" : "grayscale opacity-45"
        }`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span
          className={`truncate text-sm font-semibold ${isPresent ? "text-text" : "text-text-muted"}`}
        >
          {film.title}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {film.owned ? (
            film.formats.length > 0 ? (
              <>
                {film.formats.map((f) => (
                  <FormatBadge key={f} kind={f} />
                ))}
                <ResolutionBadge tier={film.bestTier} />
              </>
            ) : (
              <span className="text-xs text-text-faint">No files</span>
            )
          ) : isPhysicalOnly ? (
            <>
              {film.physicalMedia.map((m) => (
                <FormatBadge key={m} kind={m} />
              ))}
              <PhysicalOnlyBadge />
            </>
          ) : (
            <FormatBadge kind="MISSING" />
          )}
        </div>
      </div>
    </div>
  );

  return isPresent ? (
    <Link href={`/film/${film.id}`}>{content}</Link>
  ) : (
    <div aria-label={`${film.title} — not in library`}>{content}</div>
  );
}
