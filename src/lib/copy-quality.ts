// A film's copies named in plain words for the film page's Quality picker
// (FILM_PAGE_PLAN.md): what kind of disc a copy came from, not codecs or
// file sizes — "Ultra HD (4K Blu-ray)", "High Definition (Blu-ray)",
// "Standard (DVD)". The iPhone and Apple TV apps name them the same way
// (MediaVaultKit's CopyQuality.swift); keep the two in step.

import type { Format } from "@/lib/constants";

export interface CopySource {
  id: number;
  format: Format | string;
  edition: string | null;
  /** Only read for a copy of unknown kind, whose short label is its tier. */
  tier?: { label: string };
}

const KIND_LABELS: Record<string, string> = {
  UHD: "Ultra HD (4K Blu-ray)",
  BLURAY: "High Definition (Blu-ray)",
  DVD: "Standard (DVD)",
  HD: "High Definition",
  SD: "Standard",
};

const SHORT_LABELS: Record<string, string> = {
  UHD: "Ultra HD",
  BLURAY: "HD",
  HD: "HD",
  DVD: "SD",
  SD: "SD",
};

const RANK: Record<string, number> = { UHD: 0, BLURAY: 1, HD: 2, DVD: 3, SD: 4 };

function rank(format: string): number {
  return RANK[format] ?? 5;
}

/** The picker's label for one copy. The edition follows only when the film
 *  has another copy of the same kind — "… · Extended Edition" tells two
 *  Blu-rays apart, but beside a DVD it would just be noise. */
export function copyLabel(copy: CopySource, among: CopySource[] = []): string {
  const base = KIND_LABELS[copy.format] ?? "Other copy";
  const sameKind = among.some((c) => c.format === copy.format && c.id !== copy.id);
  return copy.edition && sameKind ? `${base} · ${copy.edition}` : base;
}

/** Just the tier, for the caption under the Quality button: "Ultra HD",
 *  "HD", "SD". */
export function copyShortLabel(copy: CopySource): string {
  return SHORT_LABELS[copy.format] ?? copy.tier?.label ?? "Other";
}

/** Best first, as the picker lists them; ties keep the lower id first so
 *  the order is stable. */
export function sortCopies<T extends CopySource>(copies: T[]): T[] {
  return [...copies].sort((a, b) => rank(a.format) - rank(b.format) || a.id - b.id);
}

/** The copy Play plays before anyone opens Quality: the one with a saved
 *  position, so a film half-watched on the Blu-ray resumes on the Blu-ray;
 *  otherwise the best copy this device can play. Null when none can. */
export function defaultCopyId<T extends CopySource>(
  copies: T[],
  canPlay: (copy: T) => boolean,
  savedOnId: number | null,
): number | null {
  const saved = copies.find((c) => c.id === savedOnId);
  if (saved && canPlay(saved)) return saved.id;
  return sortCopies(copies).find(canPlay)?.id ?? null;
}
