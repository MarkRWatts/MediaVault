import Image from "next/image";
import EpisodeRow from "@/components/EpisodeRow";
import type { SeasonView } from "@/lib/queries";

export default function SeasonSection({
  season,
  jellyfinServerId,
}: {
  season: SeasonView;
  jellyfinServerId: string | null;
}) {
  const { seasonNumber, name, posterPath, airYear, ownedCount, totalCount, episodes } = season;
  const missing = totalCount > 0 && ownedCount === 0;
  const complete = totalCount > 0 && ownedCount === totalCount;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3 border-b border-border pb-2">
        {posterPath && (
          <div className="relative aspect-2/3 w-9 shrink-0 overflow-hidden rounded border border-border">
            <Image
              src={`/api/poster/w342${posterPath}`}
              alt=""
              fill
              sizes="36px"
              className={`object-cover ${missing ? "grayscale opacity-45" : ""}`}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-x-2 gap-y-0.5">
          <h3 className="min-w-0 truncate font-display text-lg tracking-wide">
            {name || `Season ${seasonNumber}`}
          </h3>
          {airYear && <span className="shrink-0 font-mono text-xs text-text-faint">{airYear}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`font-mono text-xs ${
              missing ? "text-missing" : complete ? "text-text-muted" : "text-accent"
            }`}
          >
            {ownedCount} of {totalCount}
          </span>
          {missing && (
            <span className="text-[10px] font-semibold uppercase tracking-widest text-missing">
              Missing
            </span>
          )}
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
        {episodes.map((ep) => (
          <EpisodeRow key={ep.id} episode={ep} jellyfinServerId={jellyfinServerId} />
        ))}
      </ul>
    </section>
  );
}
