// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import LibraryBrowser from "@/components/LibraryBrowser";
import { getLibraryFilms } from "@/lib/queries";

export default async function LibraryPage() {
  const { films, filmCount, discCount } = await getLibraryFilms();

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
      <LibraryBrowser films={films} />
    </div>
  );
}
