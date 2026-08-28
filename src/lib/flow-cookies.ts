// Cookie names for the OTP sign-in/sign-up flow (app/actions/auth-flow.ts).
// In a module of their own because "use server" files may only export async
// functions, and /signin, /signup, and /onboarding all need to read these.
// Ported from jinglejotter.com's lib/flow-cookies.ts, `jj-` prefix swapped
// for `mv-`.

export const OTP_EMAIL_COOKIE = "mv-otp-email";
export const OTP_NAME_COOKIE = "mv-otp-name";
export const SIGNUP_CODE_COOKIE = "mv-signup-code";
