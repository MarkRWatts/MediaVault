// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import { headers } from "next/headers";
import LibraryBrowser from "@/components/LibraryBrowser";
import { auth } from "@/lib/auth";
import { getContinueWatchingFilms, getLibraryFilms } from "@/lib/queries";

export default async function LibraryPage() {
  // proxy.ts already guarantees a signed-in session got this far; still
  // read it directly rather than requireMemberOrRedirect() (this page has
  // never required household membership specifically, only a session) —
  // just enough to scope the continue-watching query to the right user.
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id ?? null;

  const [{ films, filmCount, discCount }, continueWatching] = await Promise.all([
    getLibraryFilms(),
    userId ? getContinueWatchingFilms(userId) : Promise.resolve([]),
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
      <LibraryBrowser films={films} continueWatching={continueWatching} />
    </div>
  );
}
