// Abuse-prevention row-count caps. One shared number for every capped
// entity — this is DoS prevention, not a real product limit, so there's no
// reason for it to vary per table. Ported as-is from the template app's
// lib/limits.ts. "2048 should be enough for anyone."

export const MAX_ROWS = 2048;

/** Friendly refusal for a create blocked by MAX_ROWS. `plural` is the noun
 *  for whatever's being counted, e.g. "invites", "codes". */
export function rowCapMessage(plural: string): string {
  return `That's ${MAX_ROWS} ${plural} — the most the app allows. Have a clear-out first.`;
}
