// DB-backed listing: must render per-request, not be frozen at build time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdultAccessOrRedirect } from "@/lib/require-member";

export default async function AdultPage() {
  await requireAdultAccessOrRedirect();

  const scenes = await prisma.scene.findMany({
    orderBy: { sortTitle: "asc" },
    select: { id: true, title: true, posterPath: true, studio: { select: { name: true } } },
  });

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Adult</h1>
        <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
          {scenes.length} scene{scenes.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        {scenes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
            <p className="font-display text-2xl tracking-wide text-text-muted">No scenes yet — run a scan</p>
            <p className="max-w-sm text-sm text-text-faint">
              Scenes appear here once ADULT_PATH has been scanned and matched.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {scenes.map((s) => (
              <Link
                key={s.id}
                href={`/adult/${s.id}`}
                className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
              >
                {s.posterPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/adult-image/${s.posterPath}`}
                    alt={s.title}
                    className="aspect-[2/3] w-full border-b border-border object-cover"
                  />
                ) : (
                  <div className="flex aspect-[2/3] w-full items-center justify-center border-b border-border bg-bg-elevated-2 text-xs text-text-faint">
                    No poster
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{s.title}</h3>
                  {s.studio && <span className="mt-auto font-mono text-xs text-text-faint">{s.studio.name}</span>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
