import AudioBadge from "@/components/AudioBadge";
import FormatBadge from "@/components/FormatBadge";
import HdrBadge from "@/components/HdrBadge";
import PlayButton from "@/components/PlayButton";
import type { PlaybackSource } from "@/components/VideoPlayer";
import { audioBadge } from "@/lib/audio";
import { UHD_BLOCKED_MESSAGE, uhdPlaybackBlocked } from "@/lib/constants";
import type { VersionView } from "@/lib/queries";

export default function VersionCard({
  version,
  filmTitle,
  playSource = null,
  audioTracks,
}: {
  version: VersionView;
  filmTitle: string;
  /** Which pipeline the in-app Play button uses, or null for no button.
   *  The film page's main Play button covers the usual single-version
   *  case; this per-version one is for films with several files. */
  playSource?: PlaybackSource | null;
  audioTracks?: { streamIdx: number; label: string }[];
}) {
  const blocked = uhdPlaybackBlocked(version);
  const specs: { label: string; value: string }[] = [
    { label: "Resolution", value: version.resolution },
    { label: "Codec", value: version.videoCodec ?? "—" },
    { label: "Container", value: version.container?.toUpperCase() ?? "—" },
    { label: "Size", value: version.sizeLabel },
    { label: "Duration", value: version.durationLabel },
  ];

  // No resolution chip in this row: the spec grid below spells the real
  // resolution out ("1920×1080"), so the tier chip was saying the same thing
  // twice in a row that now carries disc and HDR marks. The poster tiles and
  // episode rows keep theirs — those have nowhere else to show it.
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FormatBadge kind={version.format} />
        <HdrBadge videoRange={version.videoRange} />
        {version.edition && (
          <span className="text-sm italic text-text-muted">{version.edition}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* The server refuses a UHD version outright (src/lib/uhd-gate.ts),
              so the button is shown disabled whether or not this film would
              otherwise have had one — silence would read as "no file here". */}
          {blocked ? (
            <PlayButton
              versionId={version.id}
              title={filmTitle}
              disabledReason={UHD_BLOCKED_MESSAGE}
            />
          ) : (
            playSource && (
              <PlayButton versionId={version.id} title={filmTitle} source={playSource} audioTracks={audioTracks} />
            )
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        {specs.map((s) => (
          <div key={s.label}>
            <dt className="text-[10px] uppercase tracking-widest text-text-faint">{s.label}</dt>
            <dd className="mt-0.5 font-mono text-sm text-text">{s.value}</dd>
          </div>
        ))}
      </dl>

      {version.audioTracks.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-text-faint">
            Audio
          </p>
          <ul className="flex flex-col gap-1.5">
            {version.audioTracks.map((a) => {
              const badge = audioBadge(a.codec, a.profile, a.channels, a.layout);
              const { sublabel } = badge;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <AudioBadge badge={badge} />
                  {sublabel && (
                    <span className="font-mono text-[11px] text-text-muted">{sublabel}</span>
                  )}
                  <span className="font-mono text-[11px] text-text-faint">
                    {(a.language ?? "und").toUpperCase()}
                  </span>
                  {a.title && (
                    <span className="font-mono text-[11px] italic text-text-faint">{a.title}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
