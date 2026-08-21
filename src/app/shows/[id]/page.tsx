import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import PosterImage from "@/components/PosterImage";
import SeasonSection from "@/components/SeasonSection";
import { getShowDetail } from "@/lib/queries";
import { getJellyfinServerInfo } from "@/lib/jellyfin";

export default async function ShowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const showId = Number(id);
  if (!Number.isInteger(showId)) notFound();

  const show = await getShowDetail(showId);
  if (!show) notFound();

  // Only build deep links when the server is actually reachable — no error
  // state in the UI, episodes without a match simply get no chip.
  const jellyfinServer = await getJellyfinServerInfo();

  const complete = show.totalEpisodeCount > 0 && show.ownedEpisodeCount === show.totalEpisodeCount;

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative">
        {show.backdropPath && (
          <div className="absolute inset-0 h-72 overflow-hidden sm:h-96">
            <Image
              src={`/api/poster/w780${show.backdropPath}`}
              alt=""
              fill
              priority
              className="scale-105 object-cover opacity-30 blur-sm"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-bg/40 via-bg/70 to-bg" />
          </div>
        )}

        <div className="relative mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-6 sm:px-6">
          <Link
            href="/shows"
            className="w-fit text-xs font-medium text-text-muted hover:text-text"
          >
            ← Shows
          </Link>

          <div className="flex flex-col gap-6 pb-2 pt-4 sm:flex-row sm:pt-10">
            <PosterImage
              posterPath={show.posterPath}
              title={show.title}
              year={show.year}
              size="w780"
              priority
              sizes="(min-width: 640px) 224px, 55vw"
              className="aspect-2/3 w-40 shrink-0 rounded-lg border border-border-strong shadow-lg shadow-black/40 sm:w-56"
            />

            <div className="flex flex-1 flex-col gap-3 pt-1">
              <div>
                <h1 className="font-display text-4xl leading-none tracking-wide text-balance sm:text-5xl">
                  {show.title}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-text-muted">
                  <span>{show.year ?? "Year unknown"}</span>
                  {show.status && (
                    <>
                      <span className="text-text-faint">·</span>
                      <span>{show.status}</span>
                    </>
                  )}
                  {show.rating !== null && (
                    <>
                      <span className="text-text-faint">·</span>
                      <span className="flex items-center gap-1 text-accent">
                        <svg
                          aria-hidden
                          viewBox="0 0 20 20"
                          className="h-3.5 w-3.5 fill-current"
                        >
                          <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z" />
                        </svg>
                        {show.rating.toFixed(1)}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={`font-mono text-sm ${complete ? "text-text-muted" : "text-accent"}`}
                >
                  {show.ownedEpisodeCount} of {show.totalEpisodeCount} episodes
                </span>
                {!complete && (
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">
                    Incomplete
                  </span>
                )}
              </div>

              {show.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {show.genres.map((g) => (
                    <span
                      key={g}
                      className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}

              {show.overview && (
                <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                  {show.overview}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 pb-16 pt-8 sm:px-6">
        {show.seasons.length === 0 ? (
          <p className="py-16 text-center text-sm text-text-faint">
            No season data for this show yet.
          </p>
        ) : (
          show.seasons.map((season) => (
            <SeasonSection
              key={season.id}
              season={season}
              jellyfinServerId={jellyfinServer?.serverId ?? null}
            />
          ))
        )}
      </div>
    </div>
  );
}
