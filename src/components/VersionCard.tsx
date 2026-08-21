import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import type { VersionView } from "@/lib/queries";

export default function VersionCard({
  version,
  jellyfinHref,
}: {
  version: VersionView;
  jellyfinHref?: string | null;
}) {
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
        {jellyfinHref && (
          <a
            href={jellyfinHref}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium tracking-wide text-text-muted transition-colors hover:border-accent-border hover:text-accent-bright"
          >
            <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
              <path d="M2.5 1.2c0-.55.6-.9 1.08-.62l6.2 3.8c.46.28.46.94 0 1.22l-6.2 3.8c-.48.28-1.08-.07-1.08-.62V1.2z" />
            </svg>
            Play in Jellyfin
          </a>
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
