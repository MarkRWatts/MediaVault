// DB-backed listing: must render per-request, not be frozen at build time.
export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import { requireAdultAccessOrRedirect } from "@/lib/require-member";
import { AdultScenes } from "./AdultScenes";

export default async function AdultPage() {
  await requireAdultAccessOrRedirect();

  const scenes = await prisma.scene.findMany({
    orderBy: { sortTitle: "asc" },
    select: { id: true, title: true, posterPath: true, studio: { select: { name: true } } },
  });

  return <AdultScenes scenes={scenes} />;
}
