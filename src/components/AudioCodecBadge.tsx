// A music track's codec in SpecChip's one style, optionally with its
// quality as a second segment after a middle dot ("ALAC · 16/44.1",
// "MP3 · ~320k" — see qualityLabel in @/lib/audio-quality). FairPlay DRM
// (.m4p — won't play outside iTunes/Apple Music, never probed) keeps the
// "missing" colours: it's a real gap, not just another codec.

const LABELS: Record<string, string> = {
  alac: "ALAC",
  flac: "FLAC",
  mp3: "MP3",
  aac: "AAC",
  drm: "DRM",
};

export default function AudioCodecBadge({
  codec,
  quality,
  className = "",
}: {
  codec: string | null | undefined;
  quality?: string | null;
  className?: string;
}) {
  const key = (codec ?? "").toLowerCase();
  const label = LABELS[key] ?? "Unknown";

  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[3px] border px-1.5 py-px text-[11px] font-semibold leading-tight ${
        key === "drm" ? "border-missing-border bg-missing-bg text-missing" : "border-text-muted/60 text-text-muted"
      } ${className}`}
    >
      <span>{label}</span>
      {quality != null && (
        <>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span className="font-mono normal-case tracking-normal">{quality}</span>
        </>
      )}
    </span>
  );
}
