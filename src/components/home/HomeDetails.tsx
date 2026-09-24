// Under Home's active row: what the open card's title is and what it's
// about — the web's TVPickInfo (MediaVaultiOS). A film gets its meta line
// (year, certificate, runtime, best resolution and audio, genres) and its
// overview; an episode which one it is; a collection how many films over
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

function Overview({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="line-clamp-3 max-w-3xl text-sm leading-relaxed text-text/85">{text}</p>;
}

export default function HomeDetails({ item, films }: { item: HomeItem; films: HomeData["films"] }) {
  switch (item.kind) {
    case "film": {
      const film = films[item.filmId];
      if (!film) return null;
      const facts: React.ReactNode[] = [];
      if (film.year) facts.push(<span key="year">{film.year}</span>);
      if (film.certification) {
        facts.push(<CertificationBadge key="cert" certification={film.certification} height={20} />);
      }
      // formatRuntimeMins' "—" for an unknown runtime is a table's blank
      // cell; in a sentence-like line it's just left out.
      if (film.runtimeLabel && film.runtimeLabel !== "—") facts.push(<span key="runtime">{film.runtimeLabel}</span>);
      const chips = (
        <span key="chips" className="flex items-center gap-1.5">
          {film.bestTier.rank < 9 && <ResolutionBadge tier={film.bestTier} />}
          {film.audioFormats[0] && <SpecChip>{film.audioFormats[0]}</SpecChip>}
        </span>
      );
      if (film.bestTier.rank < 9 || film.audioFormats[0]) facts.push(chips);
      if (film.genres.length > 0) facts.push(<span key="genres">{film.genres.join(", ")}</span>);
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text/85">
            {facts.flatMap((fact, i) => (i === 0 ? [fact] : [<Dot key={`dot-${i}`} />, fact]))}
          </div>
          <Overview text={film.overview} />
        </div>
      );
    }
    case "episode":
      return <p className="text-sm text-text/85">{episodeLine(item.episode)}</p>;
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
