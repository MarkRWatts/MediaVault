import SpecChip from "@/components/SpecChip";
import type { ResolutionTier } from "@/lib/constants";

// The tier's own label ("1080p", "4K") where a card has room for nothing
// else — in SpecChip's one style, like every other format fact.
export default function ResolutionBadge({ tier, className = "" }: { tier: ResolutionTier; className?: string }) {
  return <SpecChip className={`font-mono ${className}`}>{tier.label}</SpecChip>;
}
