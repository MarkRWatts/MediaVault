import { formatLabel, type Format } from "@/lib/constants";

export type BadgeKind = Format | "MISSING";

const STYLES: Record<BadgeKind, string> = {
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
}: {
  kind: BadgeKind;
  className?: string;
}) {
  const label = kind === "MISSING" ? "Missing" : formatLabel(kind);
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none ${STYLES[kind]} ${className}`}
    >
      {label}
    </span>
  );
}
