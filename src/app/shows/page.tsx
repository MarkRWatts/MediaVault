// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import ShowCard from "@/components/ShowCard";
import { CARD_COLUMNS, CARD_GRID } from "@/lib/card-grid";
import { getContinueWatchingEpisodes, getShows } from "@/lib/queries";
import { jellyfinConfigured } from "@/lib/jellyfin";
import CollapsibleSection from "@/components/CollapsibleSection";
import EpisodeCard from "@/components/EpisodeCard";
import { SHELF_ITEM } from "@/lib/card-grid";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getShowIdsState } from "@/lib/film-user-state";

export default async function ShowsPage() {
  const shows = await getShows();
  const session = await auth.api.getSession({ headers: await headers() });
  const [ids, continueEpisodes] = session?.user?.id
    ? await Promise.all([
        getShowIdsState(session.user.id),
        getContinueWatchingEpisodes(session.user.id),
      ])
    : [null, []];
  const playable = jellyfinConfigured();
  const favouriteSet = new Set(ids?.favouriteIds ?? []);
  const watchedSet = new Set(ids?.watchedIds ?? []);
  const episodesOnDisk = shows.reduce((sum, s) => sum + s.ownedEpisodeCount, 0);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Shows</h1>
        {shows.length > 0 && (
          <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
            {shows.length} show{shows.length === 1 ? "" : "s"} ·{" "}
            {episodesOnDisk} episode
            {episodesOnDisk === 1 ? "" : "s"} on disk
          </p>
        )}
        {shows.length === 0 && <div className="pb-6" />}
      </div>

      {shows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="font-display text-2xl tracking-wide text-text-muted">
            No shows yet — run a scan
          </p>
          <p className="max-w-sm text-sm text-text-faint">
            Shows appear here once TVSHOWS_PATH has been scanned and matched.
          </p>
        </div>
      ) : (
        <div
          className={`flex flex-col gap-8 px-4 py-6 sm:px-6 ${CARD_COLUMNS}`}
        >
          {continueEpisodes.length > 0 && (
            <CollapsibleSection
              storageKey="shows:Continue watching"
              title="Continue watching"
              count={continueEpisodes.length}
            >
              <div className="flex gap-3 overflow-x-auto pb-2">
                {continueEpisodes.map((item) => (
                  <div key={item.episodeFileId} className={SHELF_ITEM}>
                    <EpisodeCard
                      item={{ ...item, playable: playable && item.playable }}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}
          <div className={CARD_GRID}>
            {shows.map((s) => (
              <ShowCard
                key={s.id}
                show={s}
                state={
                  ids
                    ? {
                        favourite: favouriteSet.has(s.id),
                        watched: watchedSet.has(s.id),
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
