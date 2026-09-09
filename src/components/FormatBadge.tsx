import { formatLabel, type Format } from "@/lib/constants";

export type BadgeKind = Format | "MISSING";

// The three disc formats render as their real marks (public/format-logos/:
// the DVD and Blu-ray Disc logos, and the Ultra HD Blu-ray logo from
// Wikimedia Commons) rather than a text chip — a poster wall reads them at
// a glance the way a shelf does. The DVD mark is plain black, so it's
// inverted to white for the dark theme; the two Blu-ray marks keep their
// brand blue, which already reads well on the dark cards. `scale` evens
// the marks out optically: the DVD wordmark fills its box, but the
// Blu-ray marks carry the disc swoosh above the lettering, so at equal box
// height their text would come out much smaller.
const LOGOS: Partial<Record<BadgeKind, { src: string; alt: string; invert: boolean; scale: number }>> = {
  DVD: { src: "/format-logos/dvd.svg", alt: "DVD", invert: true, scale: 1 },
  BLURAY: { src: "/format-logos/bluray.svg", alt: "Blu-ray", invert: false, scale: 1.5 },
  UHD: { src: "/format-logos/uhd-bluray.svg", alt: "Ultra HD Blu-ray", invert: false, scale: 1.3 },
};

/** Base height in CSS px of a logo on a card (the DVD mark's); the others
 *  scale from it. A shade taller than the text chip so the wordmark stays
 *  legible. */
export const FORMAT_LOGO_HEIGHT = 14;

// Everything without a mark — HD / SD web-ish rips, unknown, and the
// report's "Missing" — stays a text chip.
const STYLES: Record<BadgeKind, string> = {
  UHD: "text-accent-bright bg-accent-dim border-accent-border",
  BLURAY: "text-blu bg-blu-bg border-blu-border",
  DVD: "text-dvd bg-dvd-bg border-dvd-border",
  HD: "text-blu bg-blu-bg border-blu-border",
  SD: "text-dvd bg-dvd-bg border-dvd-border",
  UNKNOWN: "text-accent bg-transparent border-accent-border",
  MISSING: "text-missing bg-missing-bg border-missing-border",
};

export default function FormatBadge({
  kind,
  className = "",
  logoHeight = FORMAT_LOGO_HEIGHT,
}: {
  kind: BadgeKind;
  /** Extra classes for the text-chip form (padding/size overrides). */
  className?: string;
  /** Base logo height for the disc marks — the film page's version cards
   *  use a larger one than the poster grid. */
  logoHeight?: number;
}) {
  const logo = LOGOS[kind];
  if (logo) {
    const px = Math.round(logoHeight * logo.scale);
    return (
      <img
        src={logo.src}
        alt={logo.alt}
        title={logo.alt}
        className={`inline-block w-auto shrink-0 ${logo.invert ? "invert" : ""} opacity-90`}
        style={{ height: px }}
      />
    );
  }
  const label = kind === "MISSING" ? "Missing" : formatLabel(kind);
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none ${STYLES[kind]} ${className}`}
    >
      {label}
    </span>
  );
}
