// The chips and the quiet line under a film's or a show's title
// (FILM_PAGE_PLAN.md and SHOW_PAGE_PLAN.md "Chips, then the quiet line"):
// the certificate and the copy's chips — filled, not outlines — then one
// muted line of facts ending in the TMDB rating. Centred on a phone, left
// aligned over the hero on a wide screen. `note` is the show page's small
// "You have 21 of 213 episodes" under the line; `lead` a concert's performer
// above the chips.

import CertificationBadge from "@/components/CertificationBadge";
import SpecChip from "@/components/SpecChip";

export default function DetailFacts({
  certification,
  chips,
  facts,
  rating,
  note,
  lead,
}: {
  certification: string | null;
  chips: string[];
  /** "2019", "1h 59m", "Family, Fantasy" — joined with " · ". */
  facts: string[];
  rating: number | null;
  note?: string | null;
  lead?: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 text-center xl:items-start xl:text-left">
      {lead && <p className="font-display text-lg text-text-muted">{lead}</p>}
      {(certification || chips.length > 0) && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 xl:justify-start">
          <CertificationBadge certification={certification} height={24} />
          {chips.map((c) => (
            <SpecChip key={c} variant="filled">
              {c}
            </SpecChip>
          ))}
        </div>
      )}
      {(facts.length > 0 || rating !== null) && (
        <p className="text-sm text-text-muted">
          {facts.join(" · ")}
          {rating !== null && (
            <>
              {facts.length > 0 && " · "}
              <span className="whitespace-nowrap">★ {rating.toFixed(1)}</span>
            </>
          )}
        </p>
      )}
      {note && <p className="-mt-1 text-xs text-text-faint">{note}</p>}
    </div>
  );
}
