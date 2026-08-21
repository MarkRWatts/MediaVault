import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import type { VersionView } from "@/lib/queries";

export default function VersionCard({ version }: { version: VersionView }) {
  const specs: { label: string; value: string }[] = [
    { label: "Resolution", value: version.resolution },
    { label: "Codec", value: version.videoCodec ?? "—" },
    { label: "Container", value: version.container?.toUpperCase() ?? "—" },
    { label: "Size", value: version.sizeLabel },
    { label: "Duration", value: version.durationLabel },
  ];

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FormatBadge kind={version.format} className="px-2 py-1 text-[11px]" />
        <ResolutionBadge tier={version.tier} className="px-2 py-1 text-[11px]" />
        {version.edition && (
          <span className="text-sm italic text-text-muted">{version.edition}</span>
        )}
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
            {version.audioTracks.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-text-muted"
              >
                <span className="text-text">
                  {(a.language ?? "und").toUpperCase()}
                </span>
                {a.codec && <span>· {a.codec}</span>}
                {a.layout && <span>· {a.layout}</span>}
                {a.channels && !a.layout && <span>· {a.channels}ch</span>}
                {a.title && <span className="text-text-faint">· {a.title}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
