// Pure helper for /account's "Add a passkey" prompt (PASSKEYS_PLAN.md
// Phase 2): a starting suggestion for the passkey's name, derived from the
// browser's user-agent string. A suggestion, not a fact — the field stays
// fully editable — so this is deliberately coarse. It exists because the
// plugin's own AAGUID-based labelling (getAuthenticatorName) returns
// nothing for the majority case here: Apple zeroes the AAGUID under the
// `attestation: "none"` flow the plugin uses, so every iPhone/Mac passkey
// would otherwise be nameless.
//
// Known limit: iPadOS 13+ reports a "Macintosh" user-agent by default, so
// an iPad suggests "Mac". Not worth a touch-points heuristic for a label
// the person is about to look at and can retype.
/** Server-enforced bound on a passkey's name (app/actions/passkeys.ts);
 *  the client maxLength mirrors it. Shorter than MAX_TEXT_LENGTH because
 *  it's a device label rendered in a one-line row, not free text. Lives
 *  here rather than in the actions file because "use server" modules may
 *  only export async functions. */
export const PASSKEY_NAME_MAX_LENGTH = 64;

export function suggestPasskeyName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  // Android before Linux: Android user-agents contain "Linux" too.
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return "This device";
}
