import AudioBadge from "@/components/AudioBadge";
import FormatBadge from "@/components/FormatBadge";
import HdrBadge from "@/components/HdrBadge";
import type { FileSpec } from "@/lib/episode-specs";

// The one line a show or season header carries when every file under it is
// the same rip — the disc mark, the real resolution, the HDR mark, and each
// audio track's mark. Same marks and the same reading order as a film's
// version card, so a show page and a film page say the same things the same
// way; it's only the place that differs.
export default function SpecLine({
  spec,
  className = "",
}: {
  spec: FileSpec;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}>
      <FormatBadge kind={spec.format} />
      <span className="font-mono text-xs text-text-muted">{spec.resolution}</span>
      <HdrBadge videoRange={spec.videoRange} />
      {spec.audio.length > 0 ? (
        spec.audio.map((badge, i) => (
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
        spec.audioSummary && (
          <span className="font-mono text-xs text-text-faint">{spec.audioSummary}</span>
        )
      )}
    </div>
  );
}
