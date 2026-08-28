// The sign-in OTP email — the only credential path into the app (see
// HOUSEHOLDS_PLAN.md "Auth method: email OTP only"). No password, no OAuth:
// a 6-digit code sent via Resend (src/lib/email.ts).
//
// Gated by the web of trust: strangers' addresses silently get nothing, so
// nobody can probe which emails this app recognizes (the send path never
// confirms or denies an email is known). The authoritative refusal stays in
// src/lib/auth.ts's session-create hook — this gate just avoids sending
// mail to someone who could never sign in anyway.

import { isAllowedEmail } from "@/lib/allowed-email";
import { sendEmail } from "@/lib/email";

export async function sendSignInOTP({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: string;
}): Promise<void> {
  // Sign-in is the only OTP flow this app uses (no password reset, no
  // email-change flow) — anything else is a no-op rather than a surprise.
  if (type !== "sign-in") return;
  if (!(await isAllowedEmail(email))) return;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <p>Here's your MediaVault sign-in code. It expires in 10 minutes.</p>
      <p style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #ffffff; border-radius: 8px; font-size: 28px; font-weight: 600; letter-spacing: 6px;">${otp}</span>
      </p>
      <p style="color: #666;">If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  const text = `Your MediaVault sign-in code: ${otp}\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`;

  await sendEmail({ to: email, subject: `${otp} is your MediaVault sign-in code`, html, text });
}
