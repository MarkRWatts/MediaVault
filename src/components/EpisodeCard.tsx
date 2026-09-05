import Image from "next/image";
import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import PlayButton from "@/components/PlayButton";
import type { ContinueEpisode } from "@/lib/queries";

// One card in the Shows page's "Continue watching" row: the episode's still
// (or the show's poster when there is none) with a progress bar, the show
// title and episode, a Play button that resumes it in-app, and a link to
// the show.
export default function EpisodeCard({ item }: { item: ContinueEpisode }) {
  const code = `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`;
  const pct =
    item.durationSecs && item.durationSecs > 0
      ? Math.min(100, Math.round((item.positionSecs / item.durationSecs) * 100))
      : null;
  const playTitle = `${item.show.title} ${code}${item.name ? ` · ${item.name}` : ""}`;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated">
      <Link
        href={`/shows/${item.show.id}`}
        className="group relative block aspect-video w-full border-b border-border bg-bg"
      >
        {item.stillPath ? (
          <Image
            src={`/api/poster/w300${item.stillPath}`}
            alt=""
            fill
            sizes="(min-width: 1536px) 10vw, 25vw"
            className="object-cover"
          />
        ) : (
          <PosterImage
            posterPath={item.show.posterPath}
            title={item.show.title}
            year={null}
            className="h-full w-full"
          />
        )}
        {pct !== null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <Link
          href={`/shows/${item.show.id}`}
          className="line-clamp-1 text-sm font-semibold leading-snug text-text hover:text-accent-bright"
        >
          {item.show.title}
        </Link>
        <span className="line-clamp-1 font-mono text-xs text-text-muted">
          {code}
          {item.name ? ` · ${item.name}` : ""}
        </span>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[11px] text-text-faint">
            {pct !== null ? `${pct}% watched` : "In progress"}
          </span>
          {item.playable && (
            <PlayButton
              versionId={item.episodeFileId}
              title={playTitle}
              source="jellyfin"
              basePath="/api/tv-video"
              label="Resume"
            />
          )}
        </div>
      </div>
    </div>
  );
}
