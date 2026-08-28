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
