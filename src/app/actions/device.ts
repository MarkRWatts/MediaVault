"use server";

// Approve or deny a device's sign-in from /device (TVOS_PLAN.md) — the
// browser half of the Apple TV's QR-code sign-in. The iOS app calls the
// same two BetterAuth endpoints directly; the audit row for either is
// written by auth.ts's after-hook, not here, so both paths are recorded.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAPIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { requireMember } from "@/lib/require-member";

export async function decideDevice(formData: FormData): Promise<void> {
  await requireMember();
  const userCode = String(formData.get("userCode") ?? "");
  const approve = formData.get("verdict") === "approve";
  const back = `/device?user_code=${encodeURIComponent(userCode)}`;

  try {
    const request = { body: { userCode }, headers: await headers() };
    if (approve) await auth.api.deviceApprove(request);
    else await auth.api.deviceDeny(request);
  } catch (error) {
    // Expired or already decided while the page sat open: the page reads
    // the code's state again and says which.
    if (isAPIError(error)) redirect(back);
    throw error;
  }
  redirect(back);
}
