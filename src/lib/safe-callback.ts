/** Only ever a same-origin app path (e.g. an invite link) — never an
 *  absolute URL, so a crafted ?callbackURL= value can't become an open
 *  redirect. Shared by /signin and the OTP verify action.
 *
 *  Beyond the obvious "must start with / and not //": browsers treat a
 *  backslash as a slash when parsing special-scheme URLs, so `/\evil.com`
 *  in a Location header is followed as `//evil.com` — protocol-relative,
 *  i.e. straight off-site. Control characters and whitespace are refused
 *  too (header-splitting and parser-confusion fodder), and the survivor is
 *  finally parsed against a dummy origin to prove it stays on it. */
const CONTROL_WS_OR_BACKSLASH = /[\x00-\x20\x7f\\]/;

export function safeCallbackURL(raw: string | null | undefined): string {
  if (!raw) return "/";
  // Leading slash, and the second character is neither slash nor backslash.
  if (!/^\/(?![/\\])/.test(raw)) return "/";
  if (CONTROL_WS_OR_BACKSLASH.test(raw)) return "/";
  try {
    const parsed = new URL(raw, "http://mediavault.invalid");
    if (parsed.origin !== "http://mediavault.invalid") return "/";
    if (!parsed.pathname.startsWith("/")) return "/";
  } catch {
    return "/";
  }
  return raw;
}
