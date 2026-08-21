// Shown next to ResolutionBadge when a Version carries HDR data. Nothing
// renders for SDR — this badge only ever adds information, never "SDR" noise
// to a card that's SDR by default. Dolby Vision reads a shade more prominent
// than HDR10/HLG (its own accent tint vs a quiet gold outline) since it's the
// stream that most changes what Infuse actually does on direct-play.
const RANGE_LABELS: Record<string, string> = {
  HDR10: "HDR10",
  HLG: "HLG",
  DOLBY_VISION: "Dolby Vision",
};

export default function HdrBadge({
  videoRange,
  className = "",
}: {
  videoRange: string | null | undefined;
  className?: string;
}) {
  if (!videoRange || videoRange === "SDR") return null;

  const label = RANGE_LABELS[videoRange] ?? videoRange;
  const isDolbyVision = videoRange === "DOLBY_VISION";

  const style = isDolbyVision
    ? "border-accent-border bg-accent-dim text-accent-bright font-bold"
    : "border-accent-border/70 bg-transparent text-accent font-semibold";

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest leading-none ${style} ${className}`}
    >
      {label}
    </span>
  );
}
