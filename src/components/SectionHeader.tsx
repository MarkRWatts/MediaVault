// Collapsible section heading shared by the browse grid's format/collection
// sections and the shelves (Continue watching, New releases, Recently
// added, Favourites): chevron, title, film count. The parent owns the
// collapsed state (LibraryBrowser keeps it in localStorage).

export function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={`h-4 w-4 text-text-faint transition-transform ${collapsed ? "-rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SectionHeader({
  title,
  count,
  collapsed,
  onToggle,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex items-center gap-2 text-left">
      <ChevronIcon collapsed={collapsed} />
      <h2 className="font-display text-xl tracking-wide">{title}</h2>
      <span className="font-mono text-xs text-text-faint">
        {count} film{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}
