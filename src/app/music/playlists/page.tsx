// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import CoverImage from "@/components/CoverImage";
import { MusicViewSwitcher } from "@/components/music/MusicViewSwitcher";
import { getUserPlaylists } from "@/lib/queries-playlists";
import { requireMemberOrRedirect } from "@/lib/require-member";
import type { PlaylistSummary } from "@/lib/queries-playlists";

function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <Link
      href={`/music/playlist/${playlist.id}`}
      className="hover-lift flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-bg-elevated p-3"
    >
      <CoverImage
        albumId={playlist.coverAlbumId}
        version={playlist.coverVersion}
        title={playlist.name}
        fallback="glyph"
        className="h-14 w-14 shrink-0 rounded"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-text">{playlist.name}</h3>
        <span className="text-xs text-text-faint">
          {playlist.trackCount} track{playlist.trackCount === 1 ? "" : "s"}
        </span>
      </div>
    </Link>
  );
}

const GRID = "grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4";

export default async function MusicPlaylistsPage() {
  const { userId } = await requireMemberOrRedirect();
  const playlists = await getUserPlaylists(userId);

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Playlists</h1>
        <div className="mt-3 pb-6">
          <MusicViewSwitcher />
        </div>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        {playlists.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
            <p className="font-display text-2xl tracking-wide text-text-muted">No playlists yet</p>
            <p className="max-w-sm text-sm text-text-faint">
              Create one from the Playlists panel next to the player.
            </p>
          </div>
        ) : (
          <div className={GRID}>
            {playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
