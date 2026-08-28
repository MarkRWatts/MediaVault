// Transactional email sending — ported from jinglejotter.com's
// lib/email.ts `sendEmail()` (same provider: Resend, plain `fetch`, no SDK
// dependency). Phase 1.5 of HOUSEHOLDS_PLAN.md: this is standalone plumbing,
// not yet wired into anything — Phase 3's `emailOTP` plugin config will
// import this into its `sendVerificationOTP` callback to actually send sign-in
// codes. Deliberately skips jinglejotter's branded-HTML-email template system
// (cream/berry Christmas chrome, logo asset) — that's cosmetic and specific to
// that app; callers here just pass their own html/text.
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "MediaVault <noreply@markrwatts.com>",
      to,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

/** Entity-escape a user-sourced string before it's interpolated into an
 *  email's HTML body — without this, an admin display name (a free-text
 *  User.name) would be attacker-authored HTML in mail sent from our
 *  domain. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The /admin page's "email the code" action: lets the app owner hand a
 *  brand-new household its access code by mail instead of copy/pasting it
 *  themselves. Deliberately plain-text-first like sendSignInOTP (Phase 3) —
 *  the template app's branded HTML-email template system (logo asset,
 *  cream/berry chrome) is cosmetic and specific to that app, not ported. */
export async function sendAccessCodeEmail({
  to,
  inviterName,
  code,
}: {
  to: string;
  inviterName: string;
  code: string;
}) {
  const baseUrl = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  const subject = `${inviterName} invited you to MediaVault`;
  const text = `${inviterName} invited you to MediaVault.\n\nSign in using this address (${to}), then enter your access code to set up your household.\n\nYour access code: ${code}\n\n${baseUrl}/signin\n\nIf you weren't expecting this, you can safely ignore this email.`;
  const html = `<p>${escapeHtml(inviterName)} invited you to MediaVault.</p><p>Sign in using this address, then enter your access code to set up your household.</p><p style="font-size:20px;font-weight:700;letter-spacing:2px;">${escapeHtml(code)}</p><p><a href="${escapeHtml(`${baseUrl}/signin`)}">${escapeHtml(`${baseUrl}/signin`)}</a></p><p style="color:#888;font-size:12px;">If you weren't expecting this, you can safely ignore this email.</p>`;
  await sendEmail({ to, subject, html, text });
}
