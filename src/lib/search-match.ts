// The Search page's matching rule — the iPhone and Apple TV apps' own
// (MediaVaultiOS, Shared/Library/SearchMatch.swift), so a word finds the
// same things everywhere. Case- and accent-insensitive ("amelie" finds
// "Amélie"), and every word typed must begin some word of the item
// ("bourne ult" finds The Bourne Ultimatum; "ace" finds Ace of Base but not
// Peace or Graceland) — in any of the fields given, so an album also
// matches on its artist and a film on its collection.

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function searchMatches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const wanted = words(query);
  if (wanted.length === 0) return true;
  const present = fields.flatMap((f) => (f ? words(f) : []));
  return wanted.every((w) => present.some((p) => p.startsWith(w)));
}
