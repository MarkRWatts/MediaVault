// The Concerts shelf on /music. Concert rips are Film rows (Film.kind), so
// the cards deliberately look like FilmCard's — poster, title, year, format
// mark — with the act in the slot the film grid has no use for. They link
// to /film/[id], which is the same page a movie gets.

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import CollapsibleSection from "@/components/CollapsibleSection";
import type { ConcertCard } from "@/lib/queries-concerts";

function ConcertPoster({ concert }: { concert: ConcertCard }) {
  return (
    <Link
      href={`/film/${concert.id}`}
      className="hover-lift group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <PosterImage
        posterPath={concert.posterPath}
        title={concert.title}
        year={concert.year}
        className="aspect-2/3 w-full border-b border-border"
      />
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        {/* Two lines of title always, so every card in a row is the same
            height — same trick FilmCard uses. */}
        <h3
          title={concert.title}
          className="line-clamp-2 min-h-[2lh] text-sm font-semibold leading-snug text-text"
        >
          {concert.title}
        </h3>
        {concert.performer && (
          <span className="line-clamp-1 text-[11px] text-text-faint">{concert.performer}</span>
        )}
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-text-faint">{concert.year ?? "—"}</span>
          {concert.formats.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {concert.formats.slice(0, 3).map((f) => (
                <FormatBadge key={f} kind={f} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

/** Renders nothing at all when there are no concerts — an empty section
 *  would just be a header nobody with a plain music library wants. */
export default function ConcertsSection({ concerts }: { concerts: ConcertCard[] }) {
  if (concerts.length === 0) return null;

  return (
    <CollapsibleSection
      storageKey="music:Concerts"
      title="Concerts"
      count={concerts.length}
      noun="concert"
    >
      <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5 @5xl:grid-cols-6">
        {concerts.map((c) => (
          <ConcertPoster key={c.id} concert={c} />
        ))}
      </div>
    </CollapsibleSection>
  );
}
