/** Only ever a same-origin app path (e.g. an invite link) — never an
 *  absolute URL, so a crafted ?callbackURL= value can't become an open
 *  redirect. Shared by /signin and the OTP verify action. Ported as-is from
 *  jinglejotter.com's lib/safe-callback.ts. */
export function safeCallbackURL(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}
