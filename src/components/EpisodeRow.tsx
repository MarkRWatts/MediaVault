import EndsAt from "@/components/EndsAt";
import FormatBadge from "@/components/FormatBadge";
import PlayButton from "@/components/PlayButton";
import SpecLine from "@/components/SpecLine";
import { fileSpec } from "@/lib/episode-specs";
import { formatRuntimeMins, type EpisodeFileView, type EpisodeView } from "@/lib/queries";
import { isFilePlayable } from "@/lib/playback/engine-flag";

// One episode: a still you press to play, the title, how long it runs and
// when it would finish, and what it's about. Deliberately not the file's
// specs — a season ripped from one boxed set has one spec, said once in the
// header above (SpecLine / episode-specs.ts), and not the file size, which
// says nothing you'd choose an episode on.
//
// The play control sits on the still rather than beside the title: it's the
// largest target in the row, it's where the eye already is, and it leaves
// the text column to read as text.

/** Reserved even with no artwork, so the text columns line up down the list
 *  and a missing still doesn't reflow the row. */
function Still({
  stillPath,
  dimmed,
  children,
}: {
  stillPath: string | null;
  dimmed: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md border border-border bg-bg-elevated-2 sm:w-40">
      {stillPath && (
        <img
          src={`/api/poster/w300${stillPath}`}
          alt=""
          loading="lazy"
          decoding="async"
          className={`absolute inset-0 h-full w-full object-cover ${dimmed ? "opacity-45 grayscale" : ""}`}
        />
      )}
      {children}
    </div>
  );
}

// A multi-cut episode (theatrical + extended rips of the same episode) keeps
// a line per extra file: the still's play button can only stand for one of
// them, so the rest need their own, and the size is the one thing that tells
// two rips of the same episode apart at a glance.
function ExtraFile({
  file,
  playable,
  playTitle,
  hoisted,
}: {
  file: EpisodeFileView;
  playable: boolean;
  playTitle: string;
  hoisted: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {!hoisted && <SpecLine spec={fileSpec(file)} />}
      <span className="font-mono text-[11px] text-text-faint">{file.sizeLabel}</span>
      {playable && isFilePlayable(file) && (
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
  hoisted = false,
}: {
  episode: EpisodeView;
  /** playbackAvailable() — playback is possible at all right now, so
   *  individually playable files get a Play button. */
  playable: boolean;
  showTitle: string;
  seasonNumber: number;
  /** A header above already states these files' specs, so the row says
   *  nothing about them. False when the files disagree and the row is the
   *  only place they can be told apart. */
  hoisted?: boolean;
}) {
  const { episodeNumber, name, overview, stillPath, runtimeMins, owned, files } = episode;
  const playTitle = `${showTitle} S${padded(seasonNumber)}E${padded(episodeNumber)}${name ? ` · ${name}` : ""}`;

  // The still stands for one file, so it plays the one that can be played —
  // for the ordinary single-file episode that's simply the file.
  const primary = files.find((f) => isFilePlayable(f)) ?? null;
  const canPlay = playable && primary !== null;
  const extras = files.filter((f) => f !== primary);

  return (
    <li className="flex items-start gap-3 p-3 sm:gap-4">
      <Still stillPath={stillPath} dimmed={!owned}>
        {canPlay && (
          <PlayButton
            versionId={primary.id}
            title={playTitle}
            source="jellyfin"
            basePath="/api/tv-video"
            size="overlay"
            label={`Play ${playTitle}`}
          />
        )}
      </Still>

      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <span className={`text-sm ${owned ? "text-text" : "text-text-muted"}`}>
          <span className="text-text-faint">{episodeNumber}.</span>{" "}
          {name || `Episode ${episodeNumber}`}
        </span>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-faint">
          {runtimeMins !== null && <span>{formatRuntimeMins(runtimeMins)}</span>}
          {canPlay && runtimeMins !== null && (
            <>
              <span aria-hidden className="text-text-faint/50">·</span>
              <EndsAt mins={runtimeMins} />
            </>
          )}
          {owned ? (
            files.length === 0 ? (
              <span>No file info</span>
            ) : (
              !hoisted && primary !== null && <SpecLine spec={fileSpec(primary)} />
            )
          ) : (
            <FormatBadge kind="MISSING" />
          )}
        </div>

        {overview && (
          <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">{overview}</p>
        )}

        {extras.length > 0 && (
          <div className="mt-0.5 flex flex-col gap-1">
            {extras.map((f) => (
              <ExtraFile
                key={f.id}
                file={f}
                playable={playable}
                playTitle={playTitle}
                hoisted={hoisted}
              />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function padded(n: number): string {
  return n.toString().padStart(2, "0");
}
