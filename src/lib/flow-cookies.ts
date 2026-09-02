// Cookie names for the OTP sign-in/sign-up flow (app/actions/auth-flow.ts).
// In a module of their own because "use server" files may only export async
// functions, and /signin, /signup, and /onboarding all need to read these.
// Ported from jinglejotter.com's lib/flow-cookies.ts, `jj-` prefix swapped
// for `mv-`.

export const OTP_EMAIL_COOKIE = "mv-otp-email";
export const OTP_NAME_COOKIE = "mv-otp-name";
export const SIGNUP_CODE_COOKIE = "mv-signup-code";
// Set by a successful email-code sign-in (verifyOTP), read by the library
// page to offer "add a passkey for this device" — PASSKEYS_PLAN.md Phase 4.
// Lives exactly as long as the plugin's fresh-session window (24h), since
// that's how long adding a passkey is possible without signing in again.
export const PASSKEY_NUDGE_COOKIE = "mv-passkey-nudge";
