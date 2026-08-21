import Image from "next/image";
import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import HdrBadge from "@/components/HdrBadge";
import { jellyfinPlayUrl } from "@/lib/jellyfin";
import type { EpisodeFileView, EpisodeView } from "@/lib/queries";

// One file's specs on an owned episode row — badges + audio summary + size +
// an optional Jellyfin deep link. An episode normally has a single file, but
// multi-cut episodes (theatrical + extended rips of the same episode) render
// one FileLine per file, stacked, so nothing gets silently dropped.
function FileLine({
  file,
  jellyfinServerId,
}: {
  file: EpisodeFileView;
  jellyfinServerId: string | null;
}) {
  const href =
    file.jellyfinId && jellyfinServerId
      ? jellyfinPlayUrl(file.jellyfinId, jellyfinServerId)
      : null;

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
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:border-accent-border hover:text-accent-bright"
        >
          <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
            <path d="M2.5 1.2c0-.55.6-.9 1.08-.62l6.2 3.8c.46.28.46.94 0 1.22l-6.2 3.8c-.48.28-1.08-.07-1.08-.62V1.2z" />
          </svg>
          Play in Jellyfin
        </a>
      )}
    </div>
  );
}

export default function EpisodeRow({
  episode,
  jellyfinServerId,
}: {
  episode: EpisodeView;
  jellyfinServerId: string | null;
}) {
  const { episodeNumber, name, stillPath, owned, files } = episode;

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
          <Image src={`/api/poster/w300${stillPath}`} alt="" fill sizes="64px" className="object-cover" />
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
                <FileLine key={f.id} file={f} jellyfinServerId={jellyfinServerId} />
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
