import type { ResolutionTier } from "@/lib/constants";

// Visually distinct from FormatBadge (disc format) on purpose — mono type,
// its own color family per tier — so the two chip kinds never blur together
// on a dense card. 4K gets the amber-accent "collector's prize" treatment;
// 1440p/1080p read as a refined cool blue-grey; 720p is the same hue turned
// quiet; everything SD-and-below (and unknown "?") stays neutral and dim.
const TIER_STYLES: Record<number, string> = {
  0: "border-accent-border bg-accent-dim text-accent-bright font-bold shadow-[0_0_0_1px_rgba(226,165,69,0.18)]", // 4K
  1: "border-res-hd-border bg-res-hd-bg text-res-hd font-semibold", // 1440p
  2: "border-res-hd-border bg-res-hd-bg text-res-hd font-semibold", // 1080p
  3: "border-res-hd-quiet-border bg-res-hd-quiet-bg text-res-hd-quiet font-semibold", // 720p
};

const DEFAULT_STYLE = "border-border bg-bg-hover text-text-faint font-semibold";

export default function ResolutionBadge({
  tier,
  className = "",
}: {
  tier: ResolutionTier;
  className?: string;
}) {
  const style = TIER_STYLES[tier.rank] ?? DEFAULT_STYLE;
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest leading-none ${style} ${className}`}
    >
      {tier.label}
    </span>
  );
}
