import BrandMark, { type MarkSpec } from "@/components/BrandMark";
import { audioFamily, type AudioBadgeInfo, type ObjectAudio } from "@/lib/audio";

// The codecs we hold real marks for (public/format-logos/). The Dolby marks
// are black artwork, inverted to white for the dark theme. The DTS marks
// carry their own brand colour, so they're never inverted — and the two
// modern ones (dts-hd, dts-x) ship as pre-lit dark-theme variants: their
// lettering is recoloured to --ramp-0 while the orange gradient is left
// exactly as DTS drew it, since a flat invert would turn that orange blue.
//
// Deliberately *not* mapped: DTS-HD HRA and DTS-ES. The generic "dts HD"
// mark is true of HRA as well as MA, so using it for both would erase
// exactly the distinction this module exists to draw — they keep their text
// chips, which name the profile outright.
//
// The scales even the marks out optically, matching cap heights rather than
// box heights. The Dolby Digital and Atmos marks are two-line lockups
// (double-D + "Dolby" over a smaller DIGITAL/ATMOS) so they need the extra
// height before that second line is readable at all; the 2012 Dolby marks
// are single-line and four times as wide as they are tall, so the same box
// height would make their lettering twice the size; and the DTS 2020 mark is
// one bold wordmark edge to edge, which shouts at any of the above.
const MARKS: Record<string, MarkSpec> = {
  "Dolby Digital": { src: "/format-logos/dolby-digital.webp", alt: "Dolby Digital", invert: true, scale: 1.35 },
  "Dolby Digital Plus": { src: "/format-logos/dolby-digital-plus.svg", alt: "Dolby Digital Plus", invert: true, scale: 0.85 },
  "Dolby TrueHD": { src: "/format-logos/dolby-truehd.svg", alt: "Dolby TrueHD", invert: true, scale: 0.85 },
  DTS: { src: "/format-logos/dts.svg", alt: "DTS", scale: 0.9 },
  "DTS-HD MA": { src: "/format-logos/dts-hd.webp", alt: "DTS-HD Master Audio", scale: 0.85 },
};

// Object audio rides alongside the codec mark rather than replacing it —
// see the note on AudioBadgeInfo.objectAudio.
const OBJECT_MARKS: Record<ObjectAudio, MarkSpec> = {
  atmos: { src: "/format-logos/dolby-atmos.svg", alt: "Dolby Atmos", invert: true, scale: 1.35 },
  dtsx: { src: "/format-logos/dts-x.webp", alt: "DTS:X", scale: 0.9 },
};

// Quiet family tints for the text-chip fallback — same visual register as
// FormatBadge/ResolutionBadge (small, uppercase, mono, 1px translucent
// border) but its own two hues so Dolby vs DTS is legible at a glance
// without shouting. Everything else (AAC, FLAC, PCM…) stays neutral.
const FAMILY_STYLES: Record<"dolby" | "dts" | "neutral", string> = {
  dolby: "border-audio-dolby-border bg-audio-dolby-bg text-audio-dolby",
  dts: "border-audio-dts-border bg-audio-dts-bg text-audio-dts",
  neutral: "border-border bg-bg-hover text-text-muted",
};

/** Base mark height in CSS px, before each mark's own `scale`. Shorter than
 *  the disc marks — these sit in a list of text lines, not a badge row over
 *  a card. */
export const AUDIO_LOGO_HEIGHT = 15;

export default function AudioBadge({
  badge,
  logoHeight = AUDIO_LOGO_HEIGHT,
}: {
  badge: AudioBadgeInfo;
  logoHeight?: number;
}) {
  const mark = MARKS[badge.label];
  return (
    <>
      {mark ? (
        <BrandMark mark={mark} height={logoHeight} />
      ) : (
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest leading-none ${FAMILY_STYLES[audioFamily(badge.label)]}`}
        >
          {badge.label}
        </span>
      )}
      {badge.objectAudio && <BrandMark mark={OBJECT_MARKS[badge.objectAudio]} height={logoHeight} />}
    </>
  );
}
