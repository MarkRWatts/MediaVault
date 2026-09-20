// A brand logo rendered in place of a text chip — the disc formats
// (FormatBadge), the HDR ranges (HdrBadge) and the Dolby/DTS audio codecs
// (AudioBadge) all show their real marks, so a card reads the way the back
// of a case does. Everything without a mark stays a text chip in its own
// component; this only knows how to draw one.

export interface MarkSpec {
  src: string;
  /** Alt/title text — the mark replaces the label, so this is the only
   *  place the format's name survives for screen readers and hover. */
  alt: string;
  /** Artwork that's black-on-transparent, inverted to white for the dark
   *  theme. The DTS marks carry their own brand colour and are left alone. */
  invert?: boolean;
  /** Optical evener. Marks differ in how much of their box is ink — the
   *  Dolby wordmarks sit under a tall double-D, the DTS 2020 mark is
   *  lettering edge to edge — so at equal box height their text comes out
   *  at very different sizes. Multiplies the caller's base height. */
  scale?: number;
}

export default function BrandMark({
  mark,
  height,
  className = "",
}: {
  mark: MarkSpec;
  /** Base height in CSS px before the mark's own `scale`. */
  height: number;
  className?: string;
}) {
  return (
    <img
      src={mark.src}
      alt={mark.alt}
      title={mark.alt}
      className={`inline-block w-auto shrink-0 opacity-90 ${mark.invert ? "invert" : ""} ${className}`}
      style={{ height: Math.round(height * (mark.scale ?? 1)) }}
    />
  );
}
