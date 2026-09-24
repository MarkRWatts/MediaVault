"use client";

// The show page's episodes (SHOW_PAGE_PLAN.md "Season menu" and "Episode
// rows"): one season at a time under a `Series 1 ⌄` menu — replacing the
// stack of folding seasons — opening on the one you're partway through.
// Only the seasons you have episodes in, only the episodes you have; with a
// single season there's nothing to choose, so no menu.

import { useState } from "react";
import EpisodeRow, { type EpisodeRowItem } from "@/components/EpisodeRow";
import SeasonMenu from "@/components/show/SeasonMenu";

export interface ShowSeasonItem {
  seasonNumber: number;
  /** "Season 2", "Specials". */
  label: string;
  episodes: EpisodeRowItem[];
}

export default function ShowEpisodes({
  seasons,
  initialSeason,
}: {
  /** In reading order, specials last (getShowDetail sorts them so). */
  seasons: ShowSeasonItem[];
  initialSeason: number | null;
}) {
  const [seasonNumber, setSeasonNumber] = useState(initialSeason ?? seasons[0]?.seasonNumber ?? null);
  const season = seasons.find((s) => s.seasonNumber === seasonNumber) ?? seasons[0];
  if (!season) return null;

  return (
    <section className="flex flex-col gap-2" aria-label="Episodes">
      {seasons.length > 1 ? (
        <SeasonMenu
          options={seasons.map((s) => ({
            seasonNumber: s.seasonNumber,
            label: s.label,
            detail: `${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"}`,
          }))}
          value={season.seasonNumber}
          onChange={setSeasonNumber}
        />
      ) : (
        <h2 className="font-display text-xl font-semibold">Episodes</h2>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {season.episodes.map((ep) => (
          <EpisodeRow key={ep.id} episode={ep} />
        ))}
      </ul>
    </section>
  );
}
