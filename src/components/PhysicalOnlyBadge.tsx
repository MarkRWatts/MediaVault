// Marks a film/album you own on disc but haven't ripped yet — distinct from
// both a normal owned FormatBadge (which implies a ripped file exists) and
// the dashed-grayscale "truly missing" treatment (you DO have this one).

export default function PhysicalOnlyBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none text-text-faint ${className}`}
    >
      Disc only
    </span>
  );
}
