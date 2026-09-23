import SpecChip from "@/components/SpecChip";
import type { Format } from "@/lib/constants";

export type BadgeKind = Format | "MISSING";

// Disc format as a text chip in SpecChip's one style. "Ultra HD Blu-ray",
// as the format writes itself, to match the apps' "Ultra HD" badge.
const LABELS: Record<Format, string> = {
  UHD: "Ultra HD Blu-ray",
  BLURAY: "Blu-ray",
  DVD: "DVD",
  HD: "HD",
  SD: "SD",
  UNKNOWN: "Unknown",
};

export default function FormatBadge({ kind, className = "" }: { kind: BadgeKind; className?: string }) {
  // Not a format but a gap in the collection — the one chip that should
  // stand out, so it keeps its own colour.
  if (kind === "MISSING") {
    return (
      <span
        className={`inline-flex items-center rounded-[3px] border border-missing-border bg-missing-bg px-1.5 py-px text-[11px] font-semibold leading-tight text-missing ${className}`}
      >
        Missing
      </span>
    );
  }
  return <SpecChip className={className}>{LABELS[kind] ?? kind}</SpecChip>;
}
