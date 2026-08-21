// Small mono chip in FormatBadge's visual register, but for audio codec
// rather than disc format: lossless codecs (ALAC/FLAC) borrow the blu
// tokens, lossy codecs (MP3/AAC) borrow the dvd tokens, and FairPlay DRM
// (.m4p — cannot play outside iTunes/Apple Music, never probed) borrows the
// missing tokens so it reads as a real gap rather than just "another codec".
// Anything unrecognised falls back to the neutral dvd tokens.

const LABELS: Record<string, string> = {
  alac: "ALAC",
  flac: "FLAC",
  mp3: "MP3",
  aac: "AAC",
  drm: "DRM",
};

const LOSSLESS = new Set(["alac", "flac"]);
const LOSSY = new Set(["mp3", "aac"]);

function styleFor(codec: string): string {
  if (LOSSLESS.has(codec)) return "text-blu bg-blu-bg border-blu-border";
  if (LOSSY.has(codec)) return "text-dvd bg-dvd-bg border-dvd-border";
  if (codec === "drm") return "text-missing bg-missing-bg border-missing-border";
  return "text-dvd bg-dvd-bg border-dvd-border"; // unknown
}

export default function AudioCodecBadge({
  codec,
  className = "",
}: {
  codec: string | null | undefined;
  className?: string;
}) {
  const key = (codec ?? "").toLowerCase();
  const label = LABELS[key] ?? "Unknown";

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none ${styleFor(key)} ${className}`}
    >
      {label}
    </span>
  );
}
