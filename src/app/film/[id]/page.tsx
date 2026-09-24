// A film's page — the one design the iPhone app, the phone web and the
// Apple TV share (FILM_PAGE_PLAN.md), top to bottom: floating Back over a
// full-bleed backdrop with the TMDB title logo centred in its fade; the
// certificate and best-copy chips, then a quiet line of year · runtime ·
// genres · rating; one amber Play (or Resume) with Favourite · Watched ·
// Quality under it; the synopsis; then More like this. No poster, no logo
// bar (the shell drops it here, see top-nav.tsx), no Versions list and no
// technical detail: Quality picks the copy, in plain words.

import { notFound } from "next/navigation";
import BackButton from "@/components/film/BackButton";
import FilmPlayActions, { type FilmCopyOption } from "@/components/film/FilmPlayActions";
import MoreLikeThis from "@/components/film/MoreLikeThis";
import OwnerMenu from "@/components/film/OwnerMenu";
import Synopsis from "@/components/film/Synopsis";
import TitleArt from "@/components/home/TitleArt";
import CertificationBadge from "@/components/CertificationBadge";
import SpecChip from "@/components/SpecChip";
import { videoBadges } from "@/lib/video-badges";
import { isAppOwner, requireMemberOrRedirect } from "@/lib/require-member";
import { getFilmResumePoints, getFilmUserState } from "@/lib/film-user-state";
import { getFilmDetail, getMoreLikeThis } from "@/lib/queries";
import { isFilePlayable } from "@/lib/playback/engine-flag";
import { UHD_BLOCKED_MESSAGE, uhdPlaybackBlocked } from "@/lib/constants";
import { copyLabel, copyShortLabel, defaultCopyId, sortCopies } from "@/lib/copy-quality";

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
    uhdPlaybackBlocked(v) ? null : localPlay ? ("local" as const) : isFilePlayable(v) ? ("jellyfin" as const) : null;

  // Best first — the order Quality lists them, and the copy the header
  // chips describe. (getFilmDetail's own order is the database's, which is
  // how a 4K HDR film once showed "HD": the chips read the first row.)
  const copies = sortCopies(film.versions);
  const resumeOn = new Map(resumePoints.map((p) => [p.versionId, p.positionSecs]));
  const copyOptions: FilmCopyOption[] = copies.map((v) => {
    const source = playSourceFor(v);
    return {
      versionId: v.id,
      label: copyLabel(v, copies),
      shortLabel: copyShortLabel(v),
      source,
      disabledReason: source ? undefined : uhdPlaybackBlocked(v) ? UHD_BLOCKED_MESSAGE : NOT_READY,
      resumeSecs: resumeOn.get(v.id) ?? null,
    };
  });
  // The most recently watched copy keeps the film on it (resumePoints is
  // newest first); otherwise the best one that plays here.
  const startOn = defaultCopyId(copies, (v) => playSourceFor(v) !== null, resumePoints[0]?.versionId ?? null);
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

  // With no backdrop, the poster stands in, blurred and darkened.
  const heroImage = film.backdropPath
    ? { src: `/api/poster/w1280${film.backdropPath}`, className: "object-cover" }
    : film.posterPath
      ? { src: `/api/poster/w780${film.posterPath}`, className: "scale-110 object-cover blur-2xl brightness-50" }
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative">
        <div className="relative h-[45svh] max-h-[34rem] min-h-72 w-full overflow-hidden bg-bg-elevated">
          {heroImage && (
            <img
              src={heroImage.src}
              alt=""
              fetchPriority="high"
              decoding="async"
              className={`absolute inset-0 h-full w-full ${heroImage.className}`}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent via-40% to-bg" />
        </div>

        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
          {/* A concert is a Film row, but it's browsed from Music. */}
          <BackButton fallbackHref={isConcert ? "/music" : "/films"} label={isConcert ? "Music" : "Movies"} />
          {owner && <OwnerMenu filmId={film.id} physicalCopies={film.physicalCopies} />}
        </div>

        <div className="absolute inset-x-0 bottom-2 flex justify-center px-4">
          <TitleArt title={film.title} logoPath={film.logoPath} variant="hero" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-4 pt-4 sm:px-6">
        <div className="flex flex-col items-center gap-2.5 text-center">
          {isConcert && film.performer && (
            <p className="font-display text-lg text-text-muted">{film.performer}</p>
          )}
          {(film.certification || chips.length > 0 || isConcert) && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <CertificationBadge certification={film.certification} height={24} />
              {isConcert && <SpecChip variant="filled">Concert</SpecChip>}
              {chips.map((c) => (
                <SpecChip key={c} variant="filled">
                  {c}
                </SpecChip>
              ))}
            </div>
          )}
          {(facts.length > 0 || film.rating !== null) && (
            <p className="text-sm text-text-muted">
              {facts.join(" · ")}
              {film.rating !== null && (
                <>
                  {facts.length > 0 && " · "}
                  <span className="whitespace-nowrap">★ {film.rating.toFixed(1)}</span>
                </>
              )}
            </p>
          )}
        </div>

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
      </div>

      <div className="mx-auto w-full max-w-5xl pb-16 pt-8">
        <MoreLikeThis films={similar} />
      </div>
    </div>
  );
}
