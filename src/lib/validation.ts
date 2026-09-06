/** Shared input bounds for free-text form fields, enforced server-side in
 *  every action (client `maxLength` is a UX nicety, not a backstop — it's
 *  trivially bypassed by posting straight to the action). Schema columns are
 *  plain `String` (unbounded SQLite `text`), so this is the only layer that
 *  actually stops someone from stuffing a field near the server-action body
 *  limit. Ported as-is from jinglejotter.com's lib/validation.ts. */
export const MAX_TEXT_LENGTH = 256;
/** Free-form notes fields get more room than a name or catalogue number. */
export const MAX_NOTES_LENGTH = 2048;

export function isTooLong(value: string, max: number = MAX_TEXT_LENGTH): boolean {
  return value.length > max;
}

export type TextField = { ok: true; value: string | undefined } | { ok: false; error: string };

/** Read an optional free-text field from a parsed JSON body: absent or
 *  non-string -> undefined (the caller treats it as "not supplied"); a
 *  string over `max` -> an error message the route returns as a 400. Route
 *  handlers have no body-size limit of their own, so this is where an
 *  oversized value is actually stopped. */
export function readTextField(body: Record<string, unknown>, key: string, max: number = MAX_TEXT_LENGTH): TextField {
  const raw = body[key];
  if (typeof raw !== "string") return { ok: true, value: undefined };
  if (isTooLong(raw, max)) return { ok: false, error: `${key} is too long (max ${max} characters)` };
  return { ok: true, value: raw };
}

/** As readTextField, for several keys at once: the first failure wins. */
export function readTextFields(
  body: Record<string, unknown>,
  spec: Record<string, number>,
): { ok: true; values: Record<string, string | undefined> } | { ok: false; error: string } {
  const values: Record<string, string | undefined> = {};
  for (const [key, max] of Object.entries(spec)) {
    const r = readTextField(body, key, max);
    if (!r.ok) return r;
    values[key] = r.value;
  }
  return { ok: true, values };
}
