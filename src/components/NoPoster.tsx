// Fallback poster art for films with no cached image (unmatched/un-enriched,
// or a poster fetch that 404s at runtime). Meant to look intentional — a
// typeset title card, not a broken-image placeholder.

export default function NoPoster({
  title,
  year,
  className = "",
}: {
  title: string;
  year?: number | null;
  className?: string;
}) {
  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-bg-elevated-2 via-bg-elevated to-bg p-4 text-center ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 30% 20%, var(--accent) 0%, transparent 55%)",
        }}
      />
      <span aria-hidden className="absolute left-2 top-2 h-3 w-3 border-l border-t border-accent/30" />
      <span aria-hidden className="absolute right-2 top-2 h-3 w-3 border-r border-t border-accent/30" />
      <span aria-hidden className="absolute bottom-2 left-2 h-3 w-3 border-b border-l border-accent/30" />
      <span aria-hidden className="absolute bottom-2 right-2 h-3 w-3 border-b border-r border-accent/30" />
      <span className="font-display text-balance text-lg leading-[1.05] tracking-wide text-text-muted line-clamp-5">
        {title}
      </span>
      {year && <span className="mt-2 font-mono text-[11px] text-accent/70">{year}</span>}
    </div>
  );
}
