// The one look for a format fact — disc, resolution, HDR, audio codec,
// channels: small pale-grey text in a thin pale-grey outline, as the iOS
// and Apple TV apps draw theirs (and as Netflix sets its HD). They used to
// be brand logos and tinted chips; a row of those read as a row of ads,
// and each app said the same thing a different way.
//
// The film page's header uses the "filled" look instead (FILM_PAGE_PLAN.md
// "Chips"): a subtle raised fill in the text colour, beside the BBFC symbol.

export default function SpecChip({
  children,
  title,
  variant = "outline",
  className = "",
}: {
  children: React.ReactNode;
  /** Hover text, when the chip abbreviates something. */
  title?: string;
  variant?: "outline" | "filled";
  className?: string;
}) {
  const look =
    variant === "filled"
      ? "rounded-[5px] bg-bg-hover px-2 py-1 text-xs text-text"
      : "rounded-[3px] border border-text-muted/60 px-1.5 py-px text-[11px] text-text-muted";
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap font-semibold leading-tight ${look} ${className}`}
    >
      {children}
    </span>
  );
}
