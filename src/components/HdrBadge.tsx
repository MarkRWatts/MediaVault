import BrandMark, { type MarkSpec } from "@/components/BrandMark";

// Shown next to ResolutionBadge when a Version carries HDR data. Nothing
// renders for SDR — this badge only ever adds information, never "SDR" noise
// to a card that's SDR by default.
//
// HDR10 and Dolby Vision draw their real marks (public/format-logos/), both
// black artwork inverted to white for the dark theme. HLG has no mark here,
// so it keeps the quiet gold outline chip — as does any range string the
// scanner hands us that isn't one of the three.
const MARKS: Record<string, MarkSpec> = {
  HDR10: { src: "/format-logos/hdr10.svg", alt: "HDR10", invert: true },
  DOLBY_VISION: { src: "/format-logos/dolby-vision.svg", alt: "Dolby Vision", invert: true, scale: 1.15 },
};

const RANGE_LABELS: Record<string, string> = {
  HDR10: "HDR10",
  HLG: "HLG",
  DOLBY_VISION: "Dolby Vision",
};

/** Base mark height in CSS px — matches FORMAT_LOGO_HEIGHT so the disc mark
 *  and the HDR mark sit on the same optical line in a badge row. */
export const HDR_LOGO_HEIGHT = 14;

export default function HdrBadge({
  videoRange,
  className = "",
  logoHeight = HDR_LOGO_HEIGHT,
}: {
  videoRange: string | null | undefined;
  /** Extra classes for the text-chip form (padding/size overrides). */
  className?: string;
  /** Base mark height — the film page's version cards use a larger one
   *  than the episode rows. */
  logoHeight?: number;
}) {
  if (!videoRange || videoRange === "SDR") return null;

  const mark = MARKS[videoRange];
  if (mark) return <BrandMark mark={mark} height={logoHeight} />;

  const label = RANGE_LABELS[videoRange] ?? videoRange;
  return (
    <span
      className={`inline-flex items-center rounded border border-accent-border/70 bg-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest leading-none text-accent ${className}`}
    >
      {label}
    </span>
  );
}
