// Movies: the whole filterable film library — shelves, format grids,
// collections — that used to be "/" before Home (src/app/page.tsx) took
// the front page. DB-backed listing: must render per-request, not be
// frozen at build time (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import LibraryBrowser from "@/components/LibraryBrowser";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { getContinueWatchingFilms, getFavouriteFilms, getLibraryFilms, getWatchedFilmIds } from "@/lib/queries";

export default async function FilmsPage() {
  // A real session check, not proxy.ts's cookie gate (which only proves the
  // cookie was signed by this server, not that the session is live or the
  // person still a member). Membership is what vouches someone into the
  // web of trust, so the library requires it; a signed-in non-member is
  // sent to /onboarding, same as every other library page.
  const { userId, ageLimit } = await requireMemberOrRedirect();

  const [{ films, filmCount, discCount }, continueWatching, favourites, watchedIds] = await Promise.all([
    getLibraryFilms(ageLimit),
    userId ? getContinueWatchingFilms(userId, ageLimit) : Promise.resolve([]),
    userId ? getFavouriteFilms(userId, ageLimit) : Promise.resolve([]),
    userId ? getWatchedFilmIds(userId) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Movies</h1>
        {filmCount > 0 && (
          <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
            {filmCount} film{filmCount === 1 ? "" : "s"} · {discCount} disc
            {discCount === 1 ? "" : "s"}
          </p>
        )}
        {filmCount === 0 && <div className="pb-6" />}
      </div>
      <LibraryBrowser
        films={films}
        continueWatching={continueWatching}
        favourites={favourites}
        favouriteIds={favourites.map((f) => f.id)}
        watchedIds={watchedIds}
      />
    </div>
  );
}
