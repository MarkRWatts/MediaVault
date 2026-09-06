// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import LibraryBrowser from "@/components/LibraryBrowser";
import { PasskeyNudge } from "@/components/auth/PasskeyNudge";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { PASSKEY_NUDGE_COOKIE } from "@/lib/flow-cookies";
import { getContinueWatchingFilms, getFavouriteFilms, getLibraryFilms, getWatchedFilmIds } from "@/lib/queries";

export default async function LibraryPage() {
  // A real session check, not proxy.ts's cookie gate (which only proves the
  // cookie was signed by this server, not that the session is live or the
  // person still a member). Membership is what vouches someone into the
  // web of trust, so the library requires it; a signed-in non-member is
  // sent to /onboarding, same as every other library page.
  const { userId } = await requireMemberOrRedirect();
  // Set by an email-code sign-in (see verifyOTP); the strip itself decides
  // whether this device can make a passkey and whether it's been dismissed.
  const nudgePasskey = (await cookies()).has(PASSKEY_NUDGE_COOKIE);

  const [{ films, filmCount, discCount }, continueWatching, favourites, watchedIds] = await Promise.all([
    getLibraryFilms(),
    userId ? getContinueWatchingFilms(userId) : Promise.resolve([]),
    userId ? getFavouriteFilms(userId) : Promise.resolve([]),
    userId ? getWatchedFilmIds(userId) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-1 flex-col">
      {nudgePasskey && <PasskeyNudge />}
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
