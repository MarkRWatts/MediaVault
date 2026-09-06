import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import HdrBadge from "@/components/HdrBadge";
import PlayButton from "@/components/PlayButton";
import type { EpisodeFileView, EpisodeView } from "@/lib/queries";

// One file's specs on an owned episode row — badges + audio summary + size +
// an in-app Play button (through Jellyfin, /api/tv-video) when the file has
// a Jellyfin item. An episode normally has a single file, but multi-cut
// episodes (theatrical + extended rips of the same episode) render one
// FileLine per file, stacked, so nothing gets silently dropped.
function FileLine({ file, playable, playTitle }: { file: EpisodeFileView; playable: boolean; playTitle: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FormatBadge kind={file.format} />
      <ResolutionBadge tier={file.tier} />
      <HdrBadge videoRange={file.videoRange} />
      {file.audioSummary && (
        <span className="max-w-[55vw] truncate font-mono text-[11px] text-text-faint sm:max-w-xs">
          {file.audioSummary}
        </span>
      )}
      <span className="font-mono text-[11px] text-text-faint">{file.sizeLabel}</span>
      {playable && file.jellyfinId && (
        <PlayButton versionId={file.id} title={playTitle} source="jellyfin" basePath="/api/tv-video" />
      )}
    </div>
  );
}

export default function EpisodeRow({
  episode,
  playable,
  showTitle,
  seasonNumber,
}: {
  episode: EpisodeView;
  /** Jellyfin is configured, so files with a Jellyfin item get Play. */
  playable: boolean;
  showTitle: string;
  seasonNumber: number;
}) {
  const { episodeNumber, name, stillPath, owned, files } = episode;
  const playTitle = `${showTitle} S${padded(seasonNumber)}E${padded(episodeNumber)}${name ? ` · ${name}` : ""}`;

  return (
    <li className="flex items-start gap-3 p-2.5 sm:p-3">
      <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-xs text-text-faint">
        {padded(episodeNumber)}
      </span>
      {stillPath && (
        <div
          className={`relative hidden h-9 w-16 shrink-0 overflow-hidden rounded border border-border sm:block ${
            owned ? "" : "grayscale opacity-45"
          }`}
        >
          <img
            src={`/api/poster/w300${stillPath}`}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`truncate text-sm ${owned ? "text-text" : "text-text-muted"}`}>
          {name || `Episode ${episodeNumber}`}
        </span>
        {owned ? (
          files.length > 0 ? (
            <div className="flex flex-col gap-1">
              {files.map((f) => (
                <FileLine key={f.id} file={f} playable={playable} playTitle={playTitle} />
              ))}
            </div>
          ) : (
            <span className="text-xs text-text-faint">No file info</span>
          )
        ) : (
          <FormatBadge kind="MISSING" />
        )}
      </div>
    </li>
  );
}

function padded(n: number): string {
  return n.toString().padStart(2, "0");
}
