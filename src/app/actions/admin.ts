"use server";

// Owner-only actions behind /admin (see src/lib/require-member.ts's
// requireOwner): minting access codes, emailing them out, and revoking
// unused ones. Every entry point starts with requireOwner() — the page
// hiding itself from non-owners is cosmetic, this is the enforcement.
// Ported from the template app's app/actions/admin.ts.

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireOwner } from "@/lib/require-member";
import { generateCode, formatCode } from "@/lib/access";
import { sendAccessCodeEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { isTooLong } from "@/lib/validation";
import { MAX_ROWS, rowCapMessage } from "@/lib/limits";

export type AdminActionState = { error?: string; minted?: string } | null;

export type JellyfinClientState =
  | { error: string }
  | { clientId: string; clientSecret: string }
  | null;

/** Registers Jellyfin as a static, trusted OAuth client of this app's
 *  BetterAuth instance, so jellyfin-plugin-sso can authenticate against
 *  MediaVault as a generic OIDC provider — see HOUSEHOLDS_PLAN.md "Jellyfin
 *  SSO". BetterAuth's admin-create-client endpoint requires a real owner
 *  session (not just a server-only flag), which is why this is an /admin
 *  action rather than a standalone script: `headers()` here carries this
 *  request's own session cookie. skip_consent: true means household
 *  members never see /consent for this client — they're already trusted.
 *  The client_secret is returned once, here, and never stored in
 *  MediaVault itself — paste both into jellyfin-plugin-sso's provider
 *  config, not into MediaVault's .env. */
export async function registerJellyfinClient(
  _prevState: JellyfinClientState,
  formData: FormData,
): Promise<JellyfinClientState> {
  const admin = await requireOwner();

  const redirectUri = String(formData.get("redirectUri") ?? "").trim();
  if (!redirectUri) return { error: "Enter Jellyfin's redirect URI." };
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:") return { error: "Jellyfin's redirect URI must be https://." };
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }

  const existing = await prisma.oauthClient.findFirst({
    where: { redirectUris: { contains: redirectUri } },
  });
  if (existing) {
    return {
      error: `A client for this redirect URI already exists (client_id ${existing.clientId}). Its secret was only ever shown once, at creation — delete the client in the database and re-run this to issue a new one.`,
    };
  }

  let client: { client_id: string; client_secret?: string };
  try {
    client = await auth.api.adminCreateOAuthClient({
      body: {
        client_name: "Jellyfin",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "client_secret_post",
        client_secret_expires_at: 0, // never expires — jellyfin-plugin-sso has no rotation flow
        skip_consent: true,
      },
      headers: await headers(),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't register the client." };
  }
  if (!client.client_secret) return { error: "Client was created but no secret came back — odd." };

  await logAudit({ userId: admin.userId, action: "jellyfin-client.register", entityId: client.client_id });
  revalidatePath("/admin");
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

async function adminDisplayName(userId: string, email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name || email;
}

/** Mint a code, optionally emailing it straight to its person. An email
 *  address binds the code into the web of trust (that address can sign in
 *  while the code is live — src/lib/allowed-email.ts); without one the
 *  code is generic and grants no sign-in. */
export async function mintAccessCode(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireOwner();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const note = String(formData.get("note") ?? "").trim();
  const until = String(formData.get("until") ?? "").trim();
  const sendNow = Boolean(formData.get("send"));

  if (email && !email.includes("@")) return { error: "That email address doesn't look right." };
  if (isTooLong(email)) return { error: "That email address is too long." };
  if (isTooLong(note, 120)) return { error: "Keep the note under 120 characters." };
  if (sendNow && !email) return { error: "Add the email address the code should go to." };

  let redeemableUntil: Date | null = null;
  if (until) {
    redeemableUntil = new Date(`${until}T23:59:59`);
    if (Number.isNaN(redeemableUntil.getTime())) return { error: "That cutoff date doesn't parse." };
  }

  // Same DoS-prevention cap as every other user-creatable table.
  if ((await prisma.accessCode.count()) >= MAX_ROWS) return { error: rowCapMessage("codes") };

  const row = await prisma.accessCode.create({
    data: {
      code: generateCode(),
      email: email || null,
      note: note || null,
      redeemableUntil,
    },
  });

  if (sendNow) {
    try {
      await sendAccessCodeEmail({
        to: email,
        inviterName: await adminDisplayName(admin.userId, admin.email),
        code: formatCode(row.code),
      });
      await prisma.accessCode.update({ where: { id: row.id }, data: { sentAt: new Date() } });
    } catch (err) {
      // The code exists and shows in the table — surface the send failure
      // rather than pretending the whole mint failed.
      revalidatePath("/admin");
      await logAudit({ userId: admin.userId, action: "access-code.mint", entityId: row.id });
      return {
        error: `Code ${formatCode(row.code)} was minted, but the email failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      };
    }
  }

  await logAudit({ userId: admin.userId, action: "access-code.mint", entityId: row.id });
  revalidatePath("/admin");
  return { minted: formatCode(row.code) };
}

/** Send (or re-send) the invite email for an existing email-bound code. */
export async function sendCodeEmail(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireOwner();

  const codeId = String(formData.get("codeId") ?? "").trim();
  if (!codeId) return { error: "Missing code." };

  const row = await prisma.accessCode.findUnique({ where: { id: codeId } });
  if (!row) return { error: "That code wasn't found." };
  if (!row.email) return { error: "That code has no email attached — nothing to send to." };

  try {
    await sendAccessCodeEmail({
      to: row.email,
      inviterName: await adminDisplayName(admin.userId, admin.email),
      code: formatCode(row.code),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't send that email." };
  }

  await prisma.accessCode.update({ where: { id: row.id }, data: { sentAt: new Date() } });
  await logAudit({ userId: admin.userId, action: "access-code.send", entityId: row.id });
  revalidatePath("/admin");
  return null;
}

/** Revoke an UNUSED code — deleting it removes both the redemption and the
 *  sign-in vouching in one go. Redeemed codes are history (the table's
 *  audit trail of who came in how) and can't be deleted. */
export async function deleteAccessCode(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireOwner();

  const codeId = String(formData.get("codeId") ?? "").trim();
  if (!codeId) return { error: "Missing code." };

  const deleted = await prisma.accessCode.deleteMany({
    where: { id: codeId, redeemedCount: 0 },
  });
  if (deleted.count === 0) {
    return { error: "Only unused codes can be revoked — redeemed ones are the audit trail." };
  }

  await logAudit({ userId: admin.userId, action: "access-code.revoke", entityId: codeId });
  revalidatePath("/admin");
  return null;
}
