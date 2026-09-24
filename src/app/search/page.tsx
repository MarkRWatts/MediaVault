// Search: one field over the whole library — the fifth tab, as on the
// iPhone app (FILM_PAGE_PLAN.md "Everywhere"). The web had only per-page
// filter boxes (Movies, Albums) before. Like the app's SearchView, the
// lists the other pages already show are loaded once and filtered as you
// type (src/lib/search-match.ts), rather than a query per keystroke: films,
// shows, artists and albums you can play. Tracks aren't searched, as in
// the app. `?q=` seeds the field so a search can be linked or reloaded.
//
// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import SearchResults from "@/components/search/SearchResults";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { getLibraryFilms, getShows } from "@/lib/queries";
import { getMusicIndex, getPlayableAlbums } from "@/lib/queries-music";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { ageLimit } = await requireMemberOrRedirect();
  const { q } = await searchParams;

  const [{ films }, shows, music, albums] = await Promise.all([
    getLibraryFilms(ageLimit),
    getShows(ageLimit),
    getMusicIndex(),
    getPlayableAlbums(),
  ]);

  // Only what can be played here, and only the fields a result shows —
  // the whole library crosses to the browser, so it travels light.
  return (
    <SearchResults
      initialQuery={typeof q === "string" ? q : ""}
      films={films
        .filter((f) => f.owned)
        .map((f) => ({ id: f.id, title: f.title, year: f.year, posterPath: f.posterPath, collectionName: f.collectionName }))}
      shows={shows
        .filter((s) => s.ownedEpisodeCount > 0)
        .map((s) => ({ id: s.id, title: s.title, year: s.year, posterPath: s.posterPath }))}
      artists={music.artists
        .filter((a) => !a.vinylOnly)
        .map((a) => ({
          id: a.id,
          name: a.name,
          hasPhoto: a.hasPhoto,
          coverAlbumId: a.coverAlbumId,
          coverVersion: a.coverVersion,
        }))}
      albums={albums.map((a) => ({
        id: a.id,
        title: a.title,
        artistName: a.artistName,
        hasCover: a.hasCover,
        coverVersion: a.coverVersion,
      }))}
    />
  );
}
