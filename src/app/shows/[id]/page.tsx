// A show's page — the one design the iPhone app, the phone web and the
// Apple TV share (SHOW_PAGE_PLAN.md), laid out exactly as a film's page
// (DetailHero): floating Back over the backdrop with the TMDB title logo in
// its fade; the certificate and the chips every episode earns, then a quiet
// line of years · seasons · genres · rating; one amber Play naming the
// episode (Resume – Season 2, Episode 8) with Favourite · Watched under it;
// three lines of synopsis; the episodes, a season at a time under a
// `Season 1 ⌄` menu; then Films and More like this. No poster, no logo bar
// (top-nav.tsx drops it here too) and nothing technical — no disc,
// resolution or codec. "Link to a film" lives in the owner's ⋯.

import { notFound } from "next/navigation";
import DetailFacts from "@/components/film/DetailFacts";
import DetailHero from "@/components/film/DetailHero";
import FilmPlayActions from "@/components/film/FilmPlayActions";
import MoreLikeThis from "@/components/film/MoreLikeThis";
import OwnerMenu from "@/components/film/OwnerMenu";
import Synopsis from "@/components/film/Synopsis";
import ShowEpisodes, { type ShowSeasonItem } from "@/components/show/ShowEpisodes";
import type { EpisodeRowItem } from "@/components/EpisodeRow";
import ShowFilmLinksEditor from "@/components/ShowFilmLinksEditor";
import { formatRuntimeMins, getShowDetail, getShows, type EpisodeView } from "@/lib/queries";
import { initialOpenSeason } from "@/lib/season-collapse";
import { getLinkableFilms, getShowFilms } from "@/lib/queries-film-shows";
import { isFilePlayable, playbackAvailable } from "@/lib/playback/engine-flag";
import { isAppOwner, requireMemberOrRedirect } from "@/lib/require-member";
import {
  getNextEpisodeFile,
  getShowEpisodeProgress,
  getShowUserState,
  type EpisodeFileProgress,
} from "@/lib/film-user-state";
import { sharedBadges } from "@/lib/video-badges";
import { copyLabel } from "@/lib/copy-quality";
import { WATCH_PROGRESS_MIN_SECS } from "@/lib/constants";
import { airYears, episodeCode, playLabel, seasonLabel, seasonsLabel, similarShows } from "@/lib/show-page";

const TV_VIDEO = "/api/tv-video";

export default async function ShowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId, ageLimit } = await requireMemberOrRedirect();
  const { id } = await params;
  const showId = Number(id);
  if (!Number.isInteger(showId)) notFound();

  // See the film page: a withheld show 404s exactly like a missing one.
  const show = await getShowDetail(showId, ageLimit);
  if (!show) notFound();

  // Only build play controls when playback is actually available — no
  // error state on the rows, an episode that can't play simply has no play
  // glyph on its still.
  const playable = playbackAvailable();
  const [userState, next, progressRows, linkedFilms, allShows, owner] = await Promise.all([
    getShowUserState(userId, show.id),
    playable ? getNextEpisodeFile(userId, show.id) : Promise.resolve(null),
    getShowEpisodeProgress(userId, show.id),
    getShowFilms(show.id, ageLimit),
    getShows(ageLimit),
    isAppOwner(userId),
  ]);
  // Which films belong with this show is curated by hand (FilmShowLink),
  // by the owner only, from the ⋯ menu (SHOW_PAGE_PLAN.md "Owner tools").
  // The picker's pool is only fetched for them.
  const linkableFilms = owner ? await getLinkableFilms(ageLimit) : [];

  const progress = new Map(progressRows.map((p) => [p.episodeFileId, p]));

  // The episodes you have, a season at a time; seasons with none are left
  // out of the menu altogether.
  const seasons: ShowSeasonItem[] = show.seasons
    .map((season) => ({
      seasonNumber: season.seasonNumber,
      label: seasonLabel(season.seasonNumber),
      episodes: season.episodes
        .filter((ep) => ep.owned)
        .map((ep) =>
          episodeRow(ep, `${show.title} · ${episodeCode(season.seasonNumber, ep.episodeNumber)}`, playable, progress),
        ),
    }))
    .filter((s) => s.episodes.length > 0);
  // The season you're partway through (where Play points), else the first.
  const initialSeason = initialOpenSeason(
    seasons.map((s) => s.seasonNumber),
    next?.seasonNumber ?? null,
  );

  // Chips: the certificate, then what every file you have earns — the
  // same words as a film's (video-badges.ts).
  const files = show.seasons.flatMap((s) => s.episodes.filter((e) => e.owned).flatMap((e) => e.files));
  const chips = sharedBadges(files);

  const facts = [
    airYears(show.seasons, show.status, show.year),
    seasonsLabel(show.seasons.map((s) => s.seasonNumber)),
    show.genres.length > 0 ? show.genres.join(", ") : null,
  ].filter((f): f is string => f !== null);
  const incomplete = show.totalEpisodeCount > 0 && show.ownedEpisodeCount < show.totalEpisodeCount;

  const similar = similarShows(
    show,
    allShows.filter((s) => s.ownedEpisodeCount > 0),
  );

  return (
    <div className="flex flex-1 flex-col">
      <DetailHero
        title={show.title}
        logoPath={show.logoPath}
        backdropPath={show.backdropPath}
        posterPath={show.posterPath}
        back={{ fallbackHref: "/shows", label: "Shows" }}
        menu={
          owner && (
            <OwnerMenu heading="Link to a film">
              <ShowFilmLinksEditor
                showId={show.id}
                linked={linkedFilms.map((f) => ({ id: f.id, title: f.title, year: f.year }))}
                allFilms={linkableFilms}
              />
            </OwnerMenu>
          )
        }
      >
        <DetailFacts
          certification={show.certification}
          chips={chips}
          facts={facts}
          rating={show.rating}
          note={incomplete ? `You have ${show.ownedEpisodeCount} of ${show.totalEpisodeCount} episodes` : null}
        />

        <div className="w-full max-w-md">
          <FilmPlayActions
            kind="show"
            filmId={show.id}
            title={show.title}
            copies={
              next
                ? [
                    {
                      versionId: next.episodeFileId,
                      label: next.label,
                      shortLabel: next.label,
                      source: "jellyfin",
                      resumeSecs: null,
                    },
                  ]
                : []
            }
            defaultCopyId={next?.episodeFileId ?? null}
            playLabel={
              next ? playLabel(next.seasonNumber, next.episodeNumber, next.resume) : undefined
            }
            playTitle={next ? `${show.title} ${next.label}` : undefined}
            basePath={TV_VIDEO}
            playDisabledReason={!next && show.ownedEpisodeCount > 0 ? "Not ready to play yet" : undefined}
            favourite={userState.favourite}
            watched={userState.watched}
          />
        </div>

        {show.overview && (
          <div className="w-full">
            <Synopsis text={show.overview} lines={3} />
          </div>
        )}
      </DetailHero>

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-16 pt-8">
        {seasons.length > 0 && (
          <div className="px-4 sm:px-6">
            <ShowEpisodes seasons={seasons} initialSeason={initialSeason} />
          </div>
        )}
        <MoreLikeThis heading="Films" items={linkedFilms} />
        <MoreLikeThis kind="show" items={similar} />
      </div>
    </div>
  );
}

/** One row's worth of an episode, worked out here because which file can
 *  play (isFilePlayable) is the server's to say. */
function episodeRow(
  ep: EpisodeView,
  playTitleBase: string,
  playable: boolean,
  progress: Map<number, EpisodeFileProgress>,
): EpisodeRowItem {
  const playTitle = `${playTitleBase}${ep.name ? ` · ${ep.name}` : ""}`;
  // The still stands for one file, so it plays the one that can be played —
  // for the ordinary single-file episode that's simply the file.
  const playableFiles = playable ? ep.files.filter((f) => isFilePlayable(f)) : [];
  const primary = playableFiles[0] ?? null;

  // Watched once any cut of it is; partway through the one the still plays
  // (or, failing that, any other), past the same floor the player resumes
  // from, so the bar never promises a resume the player would ignore.
  const rows = ep.files.map((f) => progress.get(f.id)).filter((p): p is EpisodeFileProgress => p !== undefined);
  const watched = rows.some((p) => p.completed);
  const started =
    (primary && progress.get(primary.id)) ?? rows.find((p) => !p.completed && p.positionSecs >= WATCH_PROGRESS_MIN_SECS);
  const length = started?.durationSecs ?? (ep.runtimeMins ? ep.runtimeMins * 60 : null);
  const partway =
    !watched && started && !started.completed && started.positionSecs >= WATCH_PROGRESS_MIN_SECS && length
      ? Math.min(1, started.positionSecs / length)
      : null;

  return {
    id: ep.id,
    episodeNumber: ep.episodeNumber,
    name: ep.name,
    overview: ep.overview,
    stillPath: ep.stillPath,
    runtimeMins: ep.runtimeMins,
    runtimeLabel: ep.runtimeMins ? formatRuntimeMins(ep.runtimeMins) : null,
    play: primary ? { fileId: primary.id, title: playTitle } : null,
    progress: partway,
    watched,
    extras: playableFiles.slice(1).map((f) => ({
      fileId: f.id,
      label: copyLabel({ id: f.id, format: f.format, edition: null }),
    })),
  };
}
