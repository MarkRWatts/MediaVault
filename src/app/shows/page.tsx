// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import ShowCard from "@/components/ShowCard";
import { getShows } from "@/lib/queries";

export default async function ShowsPage() {
  const shows = await getShows();
  const episodesOnDisk = shows.reduce((sum, s) => sum + s.ownedEpisodeCount, 0);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Shows</h1>
        {shows.length > 0 && (
          <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
            {shows.length} show{shows.length === 1 ? "" : "s"} · {episodesOnDisk} episode
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
        <div className="grid grid-cols-2 gap-3 px-4 py-6 sm:grid-cols-3 sm:px-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
          {shows.map((s) => (
            <ShowCard key={s.id} show={s} />
          ))}
        </div>
      )}
    </div>
  );
}
