/** Shared input bounds for free-text form fields, enforced server-side in
 *  every action (client `maxLength` is a UX nicety, not a backstop — it's
 *  trivially bypassed by posting straight to the action). Schema columns are
 *  plain `String` (unbounded SQLite `text`), so this is the only layer that
 *  actually stops someone from stuffing a field near the server-action body
 *  limit. Ported as-is from jinglejotter.com's lib/validation.ts. */
export const MAX_TEXT_LENGTH = 256;

export function isTooLong(value: string, max: number = MAX_TEXT_LENGTH): boolean {
  return value.length > max;
}
