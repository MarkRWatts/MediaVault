"use server";

// Self-service opt-in for the Adult media type: a checkbox on the caller's
// own /account, driving both MediaVault's own viewing gate
// (User.adultLibraryAccess — see requireAdultAccessOrRedirect in
// require-member.ts) and, best-effort, the matching Jellyfin folder grant
// (syncJellyfinAdultAccess in jellyfin.ts). Kept out of account.ts, which is
// explicitly scoped to "rename yourself, delete your own account" — same
// split rationale as household.ts being its own file.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { syncJellyfinAdultAccess, type AdultSyncResult } from "@/lib/jellyfin";

export type AdultAccessState = { error?: string; jellyfin?: AdultSyncResult } | null;

async function currentUserOrThrow(): Promise<{ id: string; email: string; jellyfinUserId: string | null }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new Error("Not signed in");
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, jellyfinUserId: true },
  });
  if (!user) throw new Error("Not signed in");
  return user;
}

/** Flip the opt-in. The MediaVault-side commit always happens; a Jellyfin
 *  failure (unreachable, not yet linked) never rolls it back — see
 *  jellyfin.ts's syncJellyfinAdultAccess doc comment for why partial
 *  failure here must never look like "nothing happened". */
export async function toggleAdultLibraryAccess(
  _prevState: AdultAccessState,
  formData: FormData,
): Promise<AdultAccessState> {
  const user = await currentUserOrThrow();
  const enabled = formData.get("enabled") === "true";

  await prisma.user.update({ where: { id: user.id }, data: { adultLibraryAccess: enabled } });
  await logAudit({ userId: user.id, action: "user.adult-library-access" });

  const jellyfin = await syncJellyfinAdultAccess(user, enabled).catch(
    (err): AdultSyncResult => ({ status: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  revalidatePath("/account");
  revalidatePath("/", "layout"); // nav visibility depends on this flag
  return { jellyfin };
}

/** Re-runs the Jellyfin half only, without touching the MediaVault-side
 *  flag — for the "waiting on your first Jellyfin sign-in" state, and for
 *  retrying a transient Jellyfin failure once the account IS linked. */
export async function retryJellyfinAdultSync(
  _prevState: AdultAccessState,
  _formData: FormData,
): Promise<AdultAccessState> {
  const user = await currentUserOrThrow();
  const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { adultLibraryAccess: true } });
  const enabled = dbUser?.adultLibraryAccess ?? false;

  const jellyfin = await syncJellyfinAdultAccess(user, enabled).catch(
    (err): AdultSyncResult => ({ status: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  revalidatePath("/account");
  return { jellyfin };
}
