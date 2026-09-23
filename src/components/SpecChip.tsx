// The one look for a format fact — disc, resolution, HDR, audio codec,
// channels: small pale-grey text in a thin pale-grey outline, as the iOS
// and Apple TV apps draw theirs (and as Netflix sets its HD). They used to
// be brand logos and tinted chips; a row of those read as a row of ads,
// and each app said the same thing a different way.

export default function SpecChip({
  children,
  title,
  className = "",
}: {
  children: React.ReactNode;
  /** Hover text, when the chip abbreviates something. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-[3px] border border-text-muted/60 px-1.5 py-px text-[11px] font-semibold leading-tight text-text-muted ${className}`}
    >
      {children}
    </span>
  );
}
