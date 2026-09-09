// Playlist detail — a person's own playlist (see PLAYLISTS_PLAN.md's PR3):
// inline-renamable name, Play/Shuffle/Delete, and reorderable rows. Same
// page frame as /music/favourites (back link, then the body), but the body
// itself (including the h1) belongs to PlaylistView since the name is a
// client-side rename control, not static text.

// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlaylistDetail } from "@/lib/queries-playlists";
import { requireMemberOrRedirect } from "@/lib/require-member";
import PlaylistView from "@/components/music/PlaylistView";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await requireMemberOrRedirect();
  const { id } = await params;
  const playlistId = Number(id);
  if (!Number.isInteger(playlistId)) notFound();

  const detail = await getPlaylistDetail(userId, playlistId);
  if (!detail) notFound();

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-4 pt-6 sm:px-6">
        <Link href="/music" className="text-xs font-medium text-text-muted hover:text-text">
          ← Music
        </Link>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        <PlaylistView detail={detail} />
      </div>
    </div>
  );
}
