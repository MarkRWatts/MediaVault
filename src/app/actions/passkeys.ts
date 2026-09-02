"use server";

// Passkey management for the signed-in user (PASSKEYS_PLAN.md Phase 2):
// rename and remove. ADDING one is deliberately not here — the WebAuthn
// registration ceremony is a browser API, so that runs client-side via
// authClient.passkey.addPasskey (see components/account/PasskeyManager.tsx),
// and its audit row is written by the plugin's afterVerification hook in
// src/lib/auth.ts instead.
//
// Authorization is the plugin's, not ours: both endpoints below are wrapped
// in its sessionMiddleware + requireResourceOwnership, so a forged `id`
// for someone else's passkey is refused server-side regardless of what
// this action does. What this layer adds is the app's own input bounds and
// the content-free audit log entry.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { isTooLong } from "@/lib/validation";
import { PASSKEY_NAME_MAX_LENGTH } from "@/lib/passkey-label";

export type PasskeyActionState = { error?: string } | null;

export async function renamePasskey(
  _prevState: PasskeyActionState,
  formData: FormData,
): Promise<PasskeyActionState> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin");

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id) return { error: "Which passkey?" };
  if (!name) return { error: "Give it a name." };
  if (isTooLong(name, PASSKEY_NAME_MAX_LENGTH)) return { error: "That name is a bit long." };

  try {
    await auth.api.updatePasskey({ body: { id, name }, headers: await headers() });
  } catch {
    // Not found, or not theirs — one message for both, same posture as the
    // rest of this app's actions.
    return { error: "Couldn't rename that passkey." };
  }
  await logAudit({ userId: session.user.id, action: "passkey.rename", entityId: id });

  revalidatePath("/account");
  return null;
}

export async function removePasskey(
  _prevState: PasskeyActionState,
  formData: FormData,
): Promise<PasskeyActionState> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin");

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Which passkey?" };

  try {
    await auth.api.deletePasskey({ body: { id }, headers: await headers() });
  } catch {
    return { error: "Couldn't remove that passkey." };
  }
  await logAudit({ userId: session.user.id, action: "passkey.remove", entityId: id });

  revalidatePath("/account");
  return null;
}
