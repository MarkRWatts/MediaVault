"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Persist the signed-in user's desktop sidebar collapsed/expanded state
 *  (components/shell/sidebar.tsx). No `revalidatePath` here — the client
 *  keeps optimistic local state and the stored value only matters on the
 *  next full load. Ported from template-app's app/actions/prefs.ts. */
export async function setSidebarCollapsed(collapsed: boolean) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new Error("Not signed in");
  await prisma.user.update({
    where: { id: session.user.id },
    data: { sidebarCollapsed: collapsed },
  });
}

/** Same, for the right-hand player rail's collapsed/expanded state
 *  (components/shell/rail.tsx). */
export async function setRailCollapsed(collapsed: boolean) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new Error("Not signed in");
  await prisma.user.update({
    where: { id: session.user.id },
    data: { railCollapsed: collapsed },
  });
}
