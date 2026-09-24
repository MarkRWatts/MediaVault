// Under Home's active row: what the open card's title is and what it's
// about — the web's TVPickInfo (MediaVaultiOS). A film gets its meta line
// (year, certificate, runtime, best resolution and audio, genres) and its
// overview; an episode the same line from its show (air year, the show's
// certificate and genres, its runtime) and its overview, led by which one
// it is; a collection how many films over
// which years, and its overview. Only from what Home's payload already
// carries — no per-film fetch, so no HDR (that's per version, on the film's
// page).

import CertificationBadge from "@/components/CertificationBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import SpecChip from "@/components/SpecChip";
import { collectionLine, episodeLine } from "@/lib/home-cards";
import type { HomeData, HomeItem } from "@/lib/home-rows";

function Dot() {
  return (
    <span aria-hidden className="text-text-faint">
      ·
    </span>
  );
}

/** `lead`, in bold, starts the same three lines (an episode's "Series 2,
 *  Episode 4 · Name"), so an episode's details take no more room than a
 *  film's. */
function Overview({ text, lead }: { text: string | null; lead?: string }) {
  if (!text && !lead) return null;
  return (
    <p className="line-clamp-3 max-w-3xl text-sm leading-relaxed text-text/85">
      {lead && <strong className="font-semibold text-text">{lead}</strong>}
      {lead && text && " — "}
      {text}
    </p>
  );
}

/** Year · certificate · runtime · chips · genres, whichever there are. */
function Facts({
  year,
  certification,
  runtimeLabel,
  chips,
  genres,
}: {
  year: number | null;
  certification: string | null;
  runtimeLabel: string;
  chips?: React.ReactNode;
  genres: string[];
}) {
  const facts: React.ReactNode[] = [];
  if (year) facts.push(<span key="year">{year}</span>);
  if (certification) facts.push(<CertificationBadge key="cert" certification={certification} height={20} />);
  // formatRuntimeMins' "—" for an unknown runtime is a table's blank cell;
  // in a sentence-like line it's just left out.
  if (runtimeLabel && runtimeLabel !== "—") facts.push(<span key="runtime">{runtimeLabel}</span>);
  if (chips) facts.push(<span key="chips" className="flex items-center gap-1.5">{chips}</span>);
  if (genres.length > 0) facts.push(<span key="genres">{genres.join(", ")}</span>);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text/85">
      {facts.flatMap((fact, i) => (i === 0 ? [fact] : [<Dot key={`dot-${i}`} />, fact]))}
    </div>
  );
}

export default function HomeDetails({ item, films }: { item: HomeItem; films: HomeData["films"] }) {
  switch (item.kind) {
    case "film": {
      const film = films[item.filmId];
      if (!film) return null;
      const hasChips = film.bestTier.rank < 9 || Boolean(film.audioFormats[0]);
      return (
        <div className="flex flex-col gap-2">
          <Facts
            year={film.year}
            certification={film.certification}
            runtimeLabel={film.runtimeLabel}
            genres={film.genres}
            chips={
              hasChips ? (
                <>
                  {film.bestTier.rank < 9 && <ResolutionBadge tier={film.bestTier} />}
                  {film.audioFormats[0] && <SpecChip>{film.audioFormats[0]}</SpecChip>}
                </>
              ) : undefined
            }
          />
          <Overview text={film.overview} />
        </div>
      );
    }
    case "episode":
      return (
        <div className="flex flex-col gap-2">
          <Facts
            year={item.episode.year}
            certification={item.episode.certification}
            runtimeLabel={item.episode.runtimeLabel}
            genres={item.episode.genres}
          />
          <Overview lead={episodeLine(item.episode)} text={item.episode.overview} />
        </div>
      );
    case "collection":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text/85">
            {collectionLine(item.collection.filmIds.length, item.collection.years)}
          </p>
          <Overview text={item.collection.overview} />
        </div>
      );
    default:
      return null;
  }
}
