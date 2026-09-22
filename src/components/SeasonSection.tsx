import CollapsibleSeason from "@/components/CollapsibleSeason";
import EpisodeRow from "@/components/EpisodeRow";
import SpecLine from "@/components/SpecLine";
import { sharedSpec, seasonFiles, specExcept, type Spec } from "@/lib/episode-specs";
import type { SeasonView } from "@/lib/queries";

export default function SeasonSection({
  season,
  showId,
  playable,
  showTitle,
  hoistedSpec = null,
  defaultCollapsed = false,
}: {
  season: SeasonView;
  /** Only for the fold's storage key — a season number means nothing on
   *  its own, two shows both have a "Season 1". */
  showId: number;
  playable: boolean;
  showTitle: string;
  /** The fields the show header already states for every season, which this
   *  header and its rows therefore leave out. */
  hoistedSpec?: Spec | null;
  /** Folded on a first visit — see the show page for which seasons are. */
  defaultCollapsed?: boolean;
}) {
  const { seasonNumber, name, posterPath, airYear, ownedCount, totalCount, episodes } = season;
  const missing = totalCount > 0 && ownedCount === 0;
  const complete = totalCount > 0 && ownedCount === totalCount;

  // Everything this season's own files agree on — always at least what the
  // show header hoisted, since agreement across the whole show is agreement
  // within a season, and sometimes more (a show that changes format between
  // seasons still has each season saying one thing). That is what the rows
  // drop; the header adds only the part the show header couldn't say.
  const shared = sharedSpec(seasonFiles(season));
  const spec = shared && specExcept(shared, hoistedSpec);

  return (
    <CollapsibleSeason
      storageKey={`show:${showId}:season:${seasonNumber}`}
      defaultCollapsed={defaultCollapsed}
      header={
        <>
          {posterPath && (
            <div className="relative aspect-2/3 w-9 shrink-0 overflow-hidden rounded border border-border">
              <img
                src={`/api/poster/w342${posterPath}`}
                alt=""
                loading="lazy"
                decoding="async"
                className={`absolute inset-0 h-full w-full object-cover ${missing ? "grayscale opacity-45" : ""}`}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-baseline gap-x-2 gap-y-0.5">
              <h3 className="min-w-0 truncate font-display text-lg tracking-wide">
                {name || `Season ${seasonNumber}`}
              </h3>
              {airYear && <span className="shrink-0 font-mono text-xs text-text-faint">{airYear}</span>}
            </div>
            <SpecLine spec={spec} />
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
        </>
      }
    >
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
        {episodes.map((ep) => (
          <EpisodeRow
            key={ep.id}
            episode={ep}
            playable={playable}
            showTitle={showTitle}
            seasonNumber={seasonNumber}
            hoisted={shared}
          />
        ))}
      </ul>
    </CollapsibleSeason>
  );
}
