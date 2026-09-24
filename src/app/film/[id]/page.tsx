// A film's page — the one design the iPhone app, the phone web and the
// Apple TV share (FILM_PAGE_PLAN.md), top to bottom: floating Back over a
// full-bleed backdrop with the TMDB title logo centred in its fade; the
// certificate and best-copy chips, then a quiet line of year · runtime ·
// genres · rating; one amber Play (or Resume) with Favourite · Watched ·
// Quality under it; the synopsis; then More like this. No poster, no logo
// bar (the shell drops it here, see top-nav.tsx), no Versions list and no
// technical detail: Quality picks the copy, in plain words.

import { notFound } from "next/navigation";
import DetailFacts from "@/components/film/DetailFacts";
import DetailHero from "@/components/film/DetailHero";
import FilmPlayActions, {
  type FilmCopyOption,
} from "@/components/film/FilmPlayActions";
import MoreLikeThis from "@/components/film/MoreLikeThis";
import OwnerMenu from "@/components/film/OwnerMenu";
import Synopsis from "@/components/film/Synopsis";
import FilmPhysicalCopyForm from "@/components/FilmPhysicalCopyForm";
import { videoBadges } from "@/lib/video-badges";
import { isAppOwner, requireMemberOrRedirect } from "@/lib/require-member";
import { getFilmResumePoints, getFilmUserState } from "@/lib/film-user-state";
import { getFilmDetail, getMoreLikeThis } from "@/lib/queries";
import { isFilePlayable } from "@/lib/playback/engine-flag";
import { UHD_BLOCKED_MESSAGE, uhdPlaybackBlocked } from "@/lib/constants";
import {
  copyLabel,
  copyShortLabel,
  defaultCopyId,
  sortCopies,
} from "@/lib/copy-quality";

const NOT_READY = "Not ready to play yet";

export default async function FilmPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId, ageLimit } = await requireMemberOrRedirect();
  const { id } = await params;
  const filmId = Number(id);
  if (!Number.isInteger(filmId)) notFound();

  // Null here is either "no such film" or "above this viewer's age limit";
  // both are a 404, deliberately indistinguishable.
  const film = await getFilmDetail(filmId, ageLimit);
  if (!film) notFound();

  const isConcert = film.kind === "CONCERT";
  const versionIds = film.versions.map((v) => v.id);
  const [userState, resumePoints, similar, owner] = await Promise.all([
    getFilmUserState(userId, film.id, versionIds),
    getFilmResumePoints(userId, versionIds),
    getMoreLikeThis(film, ageLimit),
    isAppOwner(userId),
  ]);

  // In-app Play: the OLD, parked event-playlist pipeline shown only when
  // IN_APP_PLAYBACK=1 (which scripts/e2e-playback.ts sets for its own
  // server so it stays tested -- unrelated to PLAYBACK_ENGINE, see
  // src/lib/playback/engine-flag.ts's module comment); otherwise "jellyfin"
  // -- the player's session-based protocol name -- whenever the version is
  // playable at all, through whichever engine the server has picked.
  const localPlay = process.env.IN_APP_PLAYBACK === "1";
  // A UHD rip is refused by the routes (src/lib/uhd-gate.ts) whichever
  // engine is active, so it never offers a source. It stays in Quality,
  // disabled with the reason, rather than vanishing: the household knows
  // the film is on the shelf in 4K and would otherwise wonder where it went.
  const playSourceFor = (v: (typeof film.versions)[number]) =>
    uhdPlaybackBlocked(v)
      ? null
      : localPlay
        ? ("local" as const)
        : isFilePlayable(v)
          ? ("jellyfin" as const)
          : null;

  // Best first — the order Quality lists them, and the copy the header
  // chips describe. (getFilmDetail's own order is the database's, which is
  // how a 4K HDR film once showed "HD": the chips read the first row.)
  const copies = sortCopies(film.versions);
  const resumeOn = new Map(
    resumePoints.map((p) => [p.versionId, p.positionSecs]),
  );
  const copyOptions: FilmCopyOption[] = copies.map((v) => {
    const source = playSourceFor(v);
    return {
      versionId: v.id,
      label: copyLabel(v, copies),
      shortLabel: copyShortLabel(v),
      source,
      disabledReason: source
        ? undefined
        : uhdPlaybackBlocked(v)
          ? UHD_BLOCKED_MESSAGE
          : NOT_READY,
      resumeSecs: resumeOn.get(v.id) ?? null,
    };
  });
  // The most recently watched copy keeps the film on it (resumePoints is
  // newest first); otherwise the best one that plays here.
  const startOn = defaultCopyId(
    copies,
    (v) => playSourceFor(v) !== null,
    resumePoints[0]?.versionId ?? null,
  );
  const playDisabledReason =
    startOn !== null || copies.length === 0
      ? undefined
      : copies.every((v) => uhdPlaybackBlocked(v))
        ? UHD_BLOCKED_MESSAGE
        : NOT_READY;

  // The chips describe the best copy the film has, whether or not this
  // browser can play it — the same words as the iOS and Apple TV apps
  // (src/lib/video-badges.ts).
  const best = copies[0] ?? null;
  const chips = best ? videoBadges(best) : [];

  const facts = [
    film.year ? String(film.year) : null,
    film.runtimeLabel !== "—" ? film.runtimeLabel : null,
    film.genres.length > 0 ? film.genres.join(", ") : null,
  ].filter((f): f is string => f !== null);

  return (
    <div className="flex flex-1 flex-col">
      <DetailHero
        title={film.title}
        logoPath={film.logoPath}
        backdropPath={film.backdropPath}
        posterPath={film.posterPath}
        // A concert is a Film row, but it's browsed from Music.
        back={isConcert ? { fallbackHref: "/music", label: "Music" } : { fallbackHref: "/films", label: "Movies" }}
        menu={
          owner && (
            <OwnerMenu heading="Physical copies">
              <div className="flex flex-col items-start gap-3">
                {(["DVD", "BLURAY", "UHD"] as const).map((medium) => (
                  <FilmPhysicalCopyForm
                    key={medium}
                    filmId={film.id}
                    medium={medium}
                    initial={film.physicalCopies.find((c) => c.medium === medium) ?? null}
                  />
                ))}
              </div>
            </OwnerMenu>
          )
        }
      >
        <DetailFacts
          lead={isConcert ? film.performer : null}
          certification={film.certification}
          chips={isConcert ? ["Concert", ...chips] : chips}
          facts={facts}
          rating={film.rating}
        />

        <div className="w-full max-w-md">
          <FilmPlayActions
            filmId={film.id}
            title={film.title}
            copies={copyOptions}
            defaultCopyId={startOn}
            playDisabledReason={playDisabledReason}
            favourite={userState.favourite}
            watched={userState.watched}
          />
        </div>

        {film.overview && (
          <div className="w-full">
            <Synopsis text={film.overview} />
          </div>
        )}
      </DetailHero>

      <div className="mx-auto w-full max-w-5xl pb-16 pt-8">
        <MoreLikeThis items={similar} />
      </div>
    </div>
  );
}
