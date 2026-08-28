// DB-backed, per-user page — must render per-request, not be frozen at
// build time (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import { getWatchStats, formatDuration } from "@/lib/queries";
import type { RecentlyWatchedRow } from "@/lib/queries";
import { requireMemberOrRedirect } from "@/lib/require-member";

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-text-faint">{children}</p>;
}

// "12m watched" / "still going" line under a recently-watched row — shows
// position against runtime when the runtime is known, otherwise just the
// position (see getWatchStats' doc comment on why durationSecs can be null).
function progressLabel(row: RecentlyWatchedRow): string {
  if (row.completed) return "Watched";
  if (row.durationSecs) {
    const pct = Math.round((row.positionSecs / row.durationSecs) * 100);
    return `${formatDuration(row.positionSecs)} of ${formatDuration(row.durationSecs)} (${pct}%)`;
  }
  return `${formatDuration(row.positionSecs)} in`;
}

export default async function StatsPage() {
  // Personal data, not library management — any signed-in household member
  // sees their own stats, no owner gate (HOUSEHOLDS_PLAN.md's "Watch history
  // & stats", Phase 9). requireMemberOrRedirect covers both "not signed in"
  // (-> /signin) and "signed in but no household yet" (-> /onboarding), same
  // posture as /account.
  const { userId } = await requireMemberOrRedirect();
  const stats = await getWatchStats(userId);

  const tiles: { label: string; value: string | number }[] = [
    { label: "Total watch time", value: formatDuration(stats.totalWatchSecs) },
    { label: "Titles watched", value: stats.totalFilmsWatched },
    { label: "Plays", value: stats.totalPlays },
  ];

  const hasAnyHistory = stats.totalFilmsWatched > 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-6 sm:px-6">
      <div>
        <h1 className="font-display text-3xl tracking-wide">Stats</h1>
        <p className="mt-1 pb-6 text-sm text-text-faint">
          Your own watch history — total time, most-watched titles and genres, and what
          you&rsquo;ve watched recently. Nobody else&rsquo;s history is mixed in here.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3.5"
            >
              <span className="font-display text-3xl leading-none text-text">{t.value}</span>
              <span className="text-[10px] uppercase leading-tight tracking-widest text-text-faint">
                {t.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {!hasAnyHistory ? (
        <SectionEmpty>
          Nothing watched yet — play a film and its progress will show up here.
        </SectionEmpty>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl tracking-wide">Most-watched titles</h2>
            {stats.mostWatched.length === 0 ? (
              <SectionEmpty>No titles watched yet.</SectionEmpty>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {stats.mostWatched.map((f) => (
                  <Link
                    key={f.id}
                    href={`/film/${f.id}`}
                    className="hover-lift flex items-center gap-2.5 rounded-lg border border-border bg-bg-elevated p-2"
                  >
                    <PosterImage
                      posterPath={f.posterPath}
                      title={f.title}
                      year={f.year}
                      sizes="40px"
                      className="aspect-2/3 w-10 shrink-0 rounded"
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-xs text-text">{f.title}</span>
                      <span className="font-mono text-[10px] text-text-faint">
                        {f.playCount} play{f.playCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl tracking-wide">Most-watched genres</h2>
            {stats.topGenres.length === 0 ? (
              <SectionEmpty>No genre data yet.</SectionEmpty>
            ) : (
              (() => {
                const max = Math.max(1, ...stats.topGenres.map((g) => g.secs));
                return (
                  <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-elevated p-3.5">
                    {stats.topGenres.map((g) => (
                      <li key={g.genre} className="flex items-center gap-2.5">
                        <span className="w-32 shrink-0 truncate text-xs text-text-muted">
                          {g.genre}
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-hover">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${(g.secs / max) * 100}%` }}
                          />
                        </div>
                        <span className="w-16 shrink-0 text-right font-mono text-xs text-text-faint">
                          {formatDuration(g.secs)}
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl tracking-wide">Recently watched</h2>
            {stats.recentlyWatched.length === 0 ? (
              <SectionEmpty>Nothing watched yet.</SectionEmpty>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
                {stats.recentlyWatched.map((row, i) => (
                  <li
                    key={`${row.film.id}-${i}`}
                    className="flex items-center gap-3 p-3"
                  >
                    <PosterImage
                      posterPath={row.film.posterPath}
                      title={row.film.title}
                      year={row.film.year}
                      sizes="32px"
                      className="aspect-2/3 w-8 shrink-0 rounded"
                    />
                    <Link
                      href={`/film/${row.film.id}`}
                      className="min-w-0 flex-1 text-sm text-text hover:text-accent"
                    >
                      <span className="truncate">{row.film.title}</span>
                      {row.film.year && (
                        <span className="ml-2 font-mono text-xs text-text-faint">
                          {row.film.year}
                        </span>
                      )}
                    </Link>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="font-mono text-xs text-text-faint">
                        {progressLabel(row)}
                      </span>
                      <span className="font-mono text-[10px] text-text-faint">
                        {dateTimeFmt.format(new Date(row.updatedAt))}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <div className="pb-10" />
    </div>
  );
}
