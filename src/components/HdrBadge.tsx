import SpecChip from "@/components/SpecChip";

// The HDR range, named — nothing for SDR, so this only ever adds
// information rather than "SDR" noise on a card that's SDR by default.
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
  return <SpecChip className={className}>{RANGE_LABELS[videoRange] ?? videoRange}</SpecChip>;
}
