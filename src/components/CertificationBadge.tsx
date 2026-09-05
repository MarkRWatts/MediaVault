// A BBFC-style certificate chip: the familiar colour per certificate with
// the symbol in the middle (U green, PG yellow, 12A/12 orange, 15 pink,
// 18 red, R18 blue). Drawn in CSS rather than shipping the BBFC's own
// artwork; anything that isn't a BBFC certificate (a TV rating TMDB holds
// for GB, say) renders as a neutral chip with the text as given.

const BBFC: Record<string, { bg: string; fg: string; ring: string }> = {
  U: { bg: "bg-[#00a94f]", fg: "text-white", ring: "ring-[#00a94f]" },
  PG: { bg: "bg-[#fbc531]", fg: "text-black", ring: "ring-[#fbc531]" },
  "12A": { bg: "bg-[#f7941d]", fg: "text-black", ring: "ring-[#f7941d]" },
  "12": { bg: "bg-[#f7941d]", fg: "text-black", ring: "ring-[#f7941d]" },
  "15": { bg: "bg-[#ec008c]", fg: "text-white", ring: "ring-[#ec008c]" },
  "18": { bg: "bg-[#ed1c24]", fg: "text-white", ring: "ring-[#ed1c24]" },
  R18: { bg: "bg-[#1d70b8]", fg: "text-white", ring: "ring-[#1d70b8]" },
};

export default function CertificationBadge({
  certification,
  size = "sm",
  className = "",
}: {
  certification: string | null;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!certification) return null;
  const key = certification.toUpperCase();
  const style = BBFC[key];
  const dims = size === "md" ? "h-7 min-w-7 px-1.5 text-[12px]" : "h-5 min-w-5 px-1 text-[10px]";
  const title = style ? `BBFC ${key}` : `Rated ${certification}`;
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none tracking-tight ${dims} ${
        style ? `${style.bg} ${style.fg}` : "border border-border bg-bg-hover text-text-muted"
      } ${className}`}
    >
      {key}
    </span>
  );
}
