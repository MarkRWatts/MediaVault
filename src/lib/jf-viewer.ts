// Shared lookups for the Jellyfin playback routes (/api/video/<id>/jf/* for
// films, /api/tv-video/<id>/jf/* for episodes): the signed-in viewer with
// their Jellyfin user id (if the SSO plugin has created their account
// yet) and a stable device id, plus the Jellyfin item id behind a film
// Version or an EpisodeFile.

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jellyfinDeviceId } from "@/lib/jellyfin-playback";
import { linkJellyfinUserId } from "@/lib/jellyfin";

export interface Viewer {
  userId: string;
  jellyfinUserId: string | null;
  deviceId: string;
}

export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, jellyfinUserId: true } });
  if (!user) return null;
  // Jellyfin 12's PlaybackInfo now rejects requests with no UserId, so every
  // viewer needs their Jellyfin id resolved here, not just the ones who've
  // toggled adult access (the only prior path that cached it).
  const jellyfinUserId = await linkJellyfinUserId({ id: userId, email: user.email, jellyfinUserId: user.jellyfinUserId });
  return { userId, jellyfinUserId, deviceId: jellyfinDeviceId(userId) };
}

export async function jellyfinItemForVersion(versionId: number): Promise<string | null> {
  if (!Number.isInteger(versionId)) return null;
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    select: { jellyfinId: true, film: { select: { owned: true } } },
  });
  if (!version?.jellyfinId || !version.film?.owned) return null;
  return version.jellyfinId;
}

export async function jellyfinItemForEpisodeFile(episodeFileId: number): Promise<string | null> {
  if (!Number.isInteger(episodeFileId)) return null;
  const file = await prisma.episodeFile.findUnique({ where: { id: episodeFileId }, select: { jellyfinId: true } });
  return file?.jellyfinId ?? null;
}
