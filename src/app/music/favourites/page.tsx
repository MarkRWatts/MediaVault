// Favourite tracks — the pinned, built-in "Favourite tracks" list (see
// PLAYLISTS_PLAN.md's PR2). Separate page rather than overloading
// /music/playlist/[id] — real playlists don't exist yet (PR3). Same page
// frame as /music/formats: back link, h1, faint mono count/duration line.

// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { getFavouriteTracks } from "@/lib/queries-music";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { formatLongTime } from "@/lib/format-time";
import FavouriteTracksView from "@/components/music/FavouriteTracksView";

export default async function MusicFavouritesPage() {
  const { userId } = await requireMemberOrRedirect();
  const tracks = await getFavouriteTracks(userId);
  const totalSecs = tracks.reduce((sum, t) => sum + (t.durationSecs ?? 0), 0);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <Link href="/music" className="text-xs font-medium text-text-muted hover:text-text">
          ← Music
        </Link>
        <h1 className="mt-2 font-display text-3xl tracking-wide">Favourite tracks</h1>
        <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
          {tracks.length} track{tracks.length === 1 ? "" : "s"} · {formatLongTime(totalSecs)}
        </p>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        <FavouriteTracksView tracks={tracks} />
      </div>
    </div>
  );
}
