// DB-backed, per-user page — must render per-request, not be frozen at
// build time (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import HistoryTimeline from "@/components/history/HistoryTimeline";
import { getHistoryPage, getListeningTotals } from "@/lib/history";
import { getWatchStats, formatDuration } from "@/lib/queries";
import { requireMemberOrRedirect } from "@/lib/require-member";

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-text-faint">{children}</p>;
}

export default async function HistoryPage() {
  // Personal data, not library management — any signed-in household member
  // sees their own history, no owner gate (HOUSEHOLDS_PLAN.md's "Watch
  // history & stats", Phase 9). requireMemberOrRedirect covers both "not
  // signed in" (-> /signin) and "signed in but no household yet" (->
  // /onboarding), same posture as /account.
  const { userId } = await requireMemberOrRedirect();
  const [stats, listening, firstPage] = await Promise.all([
    getWatchStats(userId),
    getListeningTotals(userId),
    getHistoryPage(userId),
  ]);

  const tiles: { label: string; value: string | number }[] = [
    { label: "Total watch time", value: formatDuration(stats.totalWatchSecs) },
    { label: "Titles watched", value: stats.titlesWatched },
    { label: "Tracks played", value: listening.tracksPlayed },
    // Films, episodes and tracks together: one number for "how often did I
    // press play", which is what the tile row is for.
    { label: "Plays", value: stats.totalPlays + listening.trackPlays },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-6 sm:px-6">
      <div>
        <h1 className="font-display text-3xl tracking-wide">History</h1>
        <p className="mt-1 pb-6 text-sm text-text-faint">
          Everything you&rsquo;ve watched and listened to, newest first. Nobody else&rsquo;s
          history is mixed in here, and nobody else can see yours.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      <HistoryTimeline initial={firstPage} />

      {/* The two breakdowns the timeline can't give you: one line per event
          says what you watched, not what you keep coming back to. */}
      {stats.mostWatched.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-xl tracking-wide">Most-watched films</h2>
          <div className="grid grid-cols-2 gap-2.5 @lg:grid-cols-3 @2xl:grid-cols-4 @min-[60rem]:grid-cols-5">
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
        </section>
      )}

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
                    <span className="w-24 shrink-0 truncate text-xs text-text-muted sm:w-32">
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
      <div className="pb-10" />
    </div>
  );
}
