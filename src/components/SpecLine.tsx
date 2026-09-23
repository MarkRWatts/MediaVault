import AudioBadge from "@/components/AudioBadge";
import FormatBadge from "@/components/FormatBadge";
import HdrBadge from "@/components/HdrBadge";
import type { Spec } from "@/lib/episode-specs";

// The line a show or season header carries for whatever every file under it
// agrees on — the disc, the real resolution, the HDR range, and each audio
// track — and, on an episode row, whatever that header couldn't say. Same
// chips and the same reading order as a film's version card, so a show page
// and a film page say the same things the same way; it's only the place
// that differs.

export default function SpecLine({
  spec,
  className = "",
}: {
  spec: Spec | null;
  className?: string;
}) {
  // Nothing left to say — every field hoisted into a line above, or no file
  // to say it about. Drawing an empty row would still cost its parent's gap.
  if (!spec || !drawsAnything(spec)) return null;

  const { format, resolution, videoRange, audio } = spec;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}>
      {format && <FormatBadge kind={format} />}
      {resolution && <span className="font-mono text-xs text-text-muted">{resolution}</span>}
      <HdrBadge videoRange={videoRange} />
      {audio &&
        (audio.tracks.length > 0 ? (
          audio.tracks.map((badge, i) => (
            <span key={i} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <AudioBadge badge={badge} />
              {badge.sublabel && (
                <span className="font-mono text-xs text-text-muted">{badge.sublabel}</span>
              )}
            </span>
          ))
        ) : (
          // Probed before EpisodeAudioTrack existed; a forced TV scan replaces
          // this string with real marks.
          audio.summary && (
            <span className="font-mono text-xs text-text-faint">{audio.summary}</span>
          )
        ))}
    </div>
  );
}

// SDR draws no HDR mark (HdrBadge), and a file with neither tracks nor the
// legacy string has no audio to draw, so neither counts as something to say.
function drawsAnything(spec: Spec): boolean {
  const hdr = spec.videoRange !== null && spec.videoRange !== "SDR";
  const audio = spec.audio !== null && (spec.audio.tracks.length > 0 || spec.audio.summary !== null);
  return spec.format !== null || spec.resolution !== null || hdr || audio;
}
