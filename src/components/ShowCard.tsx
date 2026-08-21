import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import type { ShowSummary } from "@/lib/queries";

export default function ShowCard({ show }: { show: ShowSummary }) {
  const { id, title, year, posterPath, ownedEpisodeCount, totalEpisodeCount, complete } = show;
  const pct = totalEpisodeCount > 0 ? Math.round((ownedEpisodeCount / totalEpisodeCount) * 100) : 0;

  return (
    <Link
      href={`/shows/${id}`}
      className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <PosterImage
        posterPath={posterPath}
        title={title}
        year={year}
        className="aspect-2/3 w-full border-b border-border"
      />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{title}</h3>
        <span className="font-mono text-xs text-text-faint">{year ?? "—"}</span>
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
  );
}
