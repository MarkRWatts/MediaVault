// DB-backed detail page: must render per-request, not be frozen at build time.
export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdultAccessOrRedirect } from "@/lib/require-member";
import { resolutionTier, formatLabel, videoCodecLabel } from "@/lib/constants";
import { getJellyfinServerInfo, jellyfinPlayUrl } from "@/lib/jellyfin";
import AdultPlayButton from "@/components/AdultPlayButton";

export default async function SceneDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdultAccessOrRedirect();

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const [scene, jellyfinServer] = await Promise.all([
    prisma.scene.findUnique({
      where: { id },
      include: {
        studio: { select: { name: true } },
        performers: { include: { performer: { select: { id: true, name: true, imagePath: true } } } },
      },
    }),
    getJellyfinServerInfo(),
  ]);
  if (!scene) notFound();

  const jellyfinHref =
    scene.jellyfinId && jellyfinServer ? jellyfinPlayUrl(scene.jellyfinId, jellyfinServer.serverId) : null;

  const tier = resolutionTier(scene.width, scene.height);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        {scene.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/adult-image/${scene.posterPath}`}
            alt={scene.title}
            className="aspect-[2/3] w-full max-w-64 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] w-full max-w-64 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-elevated-2 text-xs text-text-faint">
            No poster
          </div>
        )}

        <div className="flex flex-1 flex-col gap-3">
          <h1 className="font-display text-3xl tracking-wide text-text">{scene.title}</h1>

          <div className="flex flex-wrap items-center gap-2 text-xs text-text-faint">
            {scene.studio && <span>{scene.studio.name}</span>}
            {scene.date && <span>{new Date(scene.date).toLocaleDateString()}</span>}
            {tier.label !== "?" && (
              <span className="rounded-full border border-border px-2 py-0.5">{tier.label}</span>
            )}
            {scene.videoCodec && (
              <span className="rounded-full border border-border px-2 py-0.5">
                {videoCodecLabel(scene.videoCodec)}
              </span>
            )}
            <span className="rounded-full border border-border px-2 py-0.5">{formatLabel(scene.format)}</span>
          </div>

          {scene.overview && <p className="text-sm text-text-muted">{scene.overview}</p>}

          {scene.performers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {scene.performers.map(({ performer }) => (
                <span
                  key={performer.id}
                  className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-xs text-text-muted"
                >
                  {performer.name}
                </span>
              ))}
            </div>
          )}

          {scene.matchConfidence === "UNMATCHED" && (
            <p className="text-xs text-text-faint">Not matched to ThePornDB yet — showing filename-derived info only.</p>
          )}

          <div className="flex items-center gap-2">
            <AdultPlayButton sceneId={scene.id} title={scene.title} />
            {jellyfinHref && (
              <a
                href={jellyfinHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium tracking-wide text-text-muted transition-colors hover:border-accent-border hover:text-accent-bright"
              >
                <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
                  <path d="M2.5 1.2c0-.55.6-.9 1.08-.62l6.2 3.8c.46.28.46.94 0 1.22l-6.2 3.8c-.48.28-1.08-.07-1.08-.62V1.2z" />
                </svg>
                Play in Jellyfin
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
