// The BBFC's own certificate symbols (public/bbfc/*.svg, the 2019 set), at
// the BBFC's recommended 30px height. 12A -- a cinema-only certificate --
// shows the 12 symbol, which is what the home-video release carries.
// Anything that isn't a BBFC certificate (a TV rating TMDB holds for GB,
// say) renders as a neutral text chip instead.

const BBFC_FILES: Record<string, string> = {
  U: "u",
  PG: "pg",
  "12": "12",
  "12A": "12",
  "15": "15",
  "18": "18",
  R18: "r18",
};

export const BBFC_ICON_HEIGHT = 30;

export default function CertificationBadge({
  certification,
  className = "",
}: {
  certification: string | null;
  className?: string;
}) {
  if (!certification) return null;
  const key = certification.toUpperCase();
  const file = BBFC_FILES[key];
  const title = file ? `BBFC ${key}` : `Rated ${certification}`;
  if (!file) {
    return (
      <span
        title={title}
        aria-label={title}
        className={`inline-flex h-5 items-center rounded-full border border-border bg-bg-hover px-1.5 text-[10px] font-bold leading-none text-text-muted ${className}`}
      >
        {key}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static SVG symbol, no optimisation wanted
    <img
      src={`/bbfc/${file}.svg`}
      alt={title}
      title={title}
      height={BBFC_ICON_HEIGHT}
      className={`inline-block w-auto shrink-0 ${className}`}
      style={{ height: BBFC_ICON_HEIGHT }}
    />
  );
}
