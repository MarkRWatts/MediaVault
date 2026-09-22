// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import { MusicViewSwitcher } from "@/components/music/MusicViewSwitcher";
import AlbumsGrid from "@/components/music/AlbumsGrid";
import { getPlayableAlbums } from "@/lib/queries-music";
import { requireMemberOrRedirect } from "@/lib/require-member";
import type { FavouriteAlbumView } from "@/lib/queries-music";

// getPlayableAlbums orders by Artist.sortName then Album.sortTitle for the
// native app's own Albums grid (src/app/api/v1/music/albums/route.ts) — left
// alone rather than repurposed here, since it's a contract the iOS client
// also depends on. This page wants artist-then-year instead, so it re-sorts
// the same rows locally. No sortName on FavouriteAlbumView, so artistName's
// plain alphabetical order stands in; close enough for a browse grid, and a
// year-less album sorts after its siblings rather than crashing to the top.
function byArtistThenYear(a: FavouriteAlbumView, b: FavouriteAlbumView): number {
  const byArtist = a.artistName.localeCompare(b.artistName);
  if (byArtist !== 0) return byArtist;
  return (a.year ?? Infinity) - (b.year ?? Infinity);
}

export default async function MusicAlbumsPage() {
  await requireMemberOrRedirect();
  const albums = (await getPlayableAlbums()).sort(byArtistThenYear);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Albums</h1>
        <div className="mt-3 pb-6">
          <MusicViewSwitcher />
        </div>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        <AlbumsGrid albums={albums} />
      </div>
    </div>
  );
}
