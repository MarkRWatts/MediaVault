import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import CardActions, { type CardState } from "@/components/CardActions";
import CertificationBadge from "@/components/CertificationBadge";
import type { ShowSummary } from "@/lib/queries";

export default function ShowCard({
  show,
  state,
}: {
  show: ShowSummary;
  state?: CardState;
}) {
  const {
    id,
    title,
    year,
    posterPath,
    certification,
    ownedEpisodeCount,
    totalEpisodeCount,
    complete,
  } = show;
  const pct =
    totalEpisodeCount > 0
      ? Math.round((ownedEpisodeCount / totalEpisodeCount) * 100)
      : 0;

  return (
    <div className="relative h-full">
      {state && (
        <CardActions kind="show" filmId={id} title={title} state={state} />
      )}
      <Link
        href={`/shows/${id}`}
        className="hover-lift group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
      >
        <PosterImage
          posterPath={posterPath}
          title={title}
          year={year}
          className="aspect-2/3 w-full border-b border-border"
        />
        <div className="flex flex-1 flex-col gap-2 p-3">
          <h3
            title={title}
            className="line-clamp-2 min-h-[2lh] text-sm font-semibold leading-snug text-text"
          >
            {title}
          </h3>
          <span className="flex items-center gap-1.5 font-mono text-xs text-text-faint">
            <CertificationBadge certification={certification} />
            {year ?? "—"}
          </span>
          <div className="mt-auto flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span
                className={`font-mono text-xs ${complete ? "text-text-muted" : "text-accent"}`}
              >
                {ownedEpisodeCount} of {totalEpisodeCount} episodes
              </span>
              {!complete && (
                <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">
                  Incomplete
                </span>
              )}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-bg-elevated-2">
              <div
                className={`h-full rounded-full ${complete ? "bg-good" : "bg-accent"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}
