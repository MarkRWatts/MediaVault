// Age-rating gate: which BBFC certificates a household member may see,
// derived from the date of birth a household owner set on their Member row
// (prisma/schema.prisma). Pure functions only — no session, no database; the
// DB/session half lives in src/lib/age-gate.ts and the filtering half in
// src/lib/queries.ts.
//
// The rule in one line: a member with no date of birth sees everything; a
// member with one sees only certificates whose minimum age is at or below
// their age today, and NOTHING whose certificate we can't read.
//
// That last clause is the whole design. Film.certification / Show.certification
// are nullable and only populated by TMDB enrichment (src/lib/tmdb.ts), so an
// unmatched, unenriched or foreign-only title has no certificate at all. An
// unknown certificate is treated as "too old", never as "probably fine" — a
// restricted member sees a smaller library rather than an accidental 18.

/** A viewer's ceiling. `"unrestricted"` is the no-date-of-birth default (an
 *  adult member); a number is their age in whole years today. Deliberately
 *  NOT `number | null`: an accidental null/undefined at a call site is then a
 *  type error rather than a silently unrestricted viewer. */
export type AgeLimit = number | "unrestricted";

/** The minimum age each BBFC certificate is passed for. U and PG are 0 —
 *  PG is advisory ("general viewing, but some scenes may be unsuitable for
 *  young children"), not an age bar. 12A is the cinema-only twin of 12 and
 *  carries the same 12; R18 is 18 plus a licensed-premises restriction that
 *  has no bearing on a home library.
 *
 *  This is the complete vocabulary. A certificate string outside it (a
 *  non-GB rating TMDB happened to hold, a future BBFC symbol) is unknown,
 *  and unknown means hidden — see allowsCertificate. */
export const CERTIFICATE_MIN_AGE: Readonly<Record<string, number>> = {
  U: 0,
  PG: 0,
  "12": 12,
  "12A": 12,
  "15": 15,
  "18": 18,
  R18: 18,
};

/** The minimum age for `certification`, or null when there isn't one we
 *  recognise (including no certificate at all). Case- and space-insensitive:
 *  TMDB hands back "12A", but a hand-edited row could hold "12a". */
export function minimumAgeFor(certification: string | null | undefined): number | null {
  if (!certification) return null;
  const key = certification.trim().toUpperCase();
  return key in CERTIFICATE_MIN_AGE ? CERTIFICATE_MIN_AGE[key] : null;
}

/** Whole years completed between `dateOfBirth` and `now`, in UTC. Birthdays
 *  count on the day: someone born 2014-03-02 is 12 from 2026-03-02 onwards.
 *  UTC on both sides because the stored value is a date pinned to UTC
 *  midnight, not an instant — comparing it in a local timezone would make a
 *  birthday land a day early or late depending on where the server sits. */
export function ageInYears(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  // A date of birth in the future is nonsense the form already rejects; if
  // one ever lands in the table anyway, clamp to 0 (the strictest limit)
  // rather than going negative, which would allow nothing at all including U.
  return Math.max(0, age);
}

/** The ceiling for a Member row's dateOfBirth. Null (the column's default)
 *  is an unrestricted adult member. */
export function ageLimitFor(dateOfBirth: Date | null | undefined, now: Date = new Date()): AgeLimit {
  if (!dateOfBirth) return "unrestricted";
  return ageInYears(dateOfBirth, now);
}

/** May a viewer at `limit` see something carrying `certification`?
 *
 *  The fail-safe: an unrecognised or absent certificate is false for every
 *  restricted viewer, whatever their age — a 17-year-old is shown nothing
 *  unrated, same as a 7-year-old. Only "unrestricted" short-circuits. */
export function allowsCertificate(limit: AgeLimit, certification: string | null | undefined): boolean {
  if (limit === "unrestricted") return true;
  const minimum = minimumAgeFor(certification);
  if (minimum === null) return false;
  return minimum <= limit;
}

/** The BBFC certificates in the order they're always presented — least to
 *  most restrictive. CERTIFICATE_MIN_AGE can't supply this on its own: 12A
 *  and 12 share an age, as do 18 and R18, so the ordering between them is a
 *  presentation decision rather than something derivable. */
export const CERTIFICATE_ORDER: readonly string[] = ["U", "PG", "12A", "12", "15", "18", "R18"];

/** The certificates `limit` may see, in BBFC order — for the /account copy
 *  that tells an owner what a restriction actually does. Empty is possible
 *  in principle only if the table ever gains a certificate above 18. */
export function allowedCertificates(limit: AgeLimit): string[] {
  return CERTIFICATE_ORDER.filter((c) => allowsCertificate(limit, c));
}

/** One-line summary of a restriction for the household UI, e.g.
 *  "12 years old — U, PG, 12A and 12". */
export function ageLimitLabel(limit: AgeLimit): string {
  if (limit === "unrestricted") return "No age restriction";
  const allowed = allowedCertificates(limit);
  const list =
    allowed.length === 0
      ? "nothing"
      : allowed.length === 1
        ? allowed[0]
        : `${allowed.slice(0, -1).join(", ")} and ${allowed[allowed.length - 1]}`;
  return `${limit} year${limit === 1 ? "" : "s"} old — ${list}`;
}
