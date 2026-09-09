"use client";

// The rail's playlists list — the pinned, built-in "Favourite tracks" row
// (see PLAYLISTS_PLAN.md's PR2) plus the signed-in person's own playlists
// beneath it, and a "New playlist" action. Row style mirrors
// queue-panel.tsx's rows. Playlists themselves come from usePlaylists()
// (components/player/PlaylistsContext.tsx) — AppShell reads them
// server-side once per request, so this component never fetches on its
// own; a mutation's router.refresh() is what brings a new/renamed/deleted
// playlist here.

import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Heart, Plus } from "lucide-react";
import { loadPlaylistQueue, createPlaylist } from "@/app/actions/music-state";
import { usePlayer } from "@/components/player/usePlayer";
import { usePlaylists } from "@/components/player/PlaylistsContext";
import { PlayIcon } from "@/components/player/icons";
import CoverImage from "@/components/CoverImage";

const PLAYLIST_NAME_MAX = 80;

export function PlaylistsPanel({ favouriteTrackCount }: { favouriteTrackCount: number }) {
  const router = useRouter();
  const { snapshot, engine } = usePlayer();
  const { playlists } = usePlaylists();
  const [pending, startTransition] = useTransition();
  const [playingId, setPlayingId] = useState<number | "favourites" | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handlePlayFavourites() {
    setPlayingId("favourites");
    startTransition(async () => {
      const tracks = await loadPlaylistQueue("favourites");
      engine.playTracks(tracks, { context: { kind: "favourites" } });
    });
  }

  function handlePlayPlaylist(id: number, name: string) {
    setPlayingId(id);
    startTransition(async () => {
      const tracks = await loadPlaylistQueue(id);
      engine.playTracks(tracks, { context: { kind: "playlist", playlistId: id, title: name } });
    });
  }

  function openCreate() {
    setError(null);
    setName("");
    setCreating(true);
    // Autofocus once the input's mounted.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelCreate() {
    setCreating(false);
    setName("");
    setError(null);
  }

  function submitCreate() {
    setError(null);
    startTransition(async () => {
      try {
        const { id } = await createPlaylist(name);
        setCreating(false);
        setName("");
        router.refresh();
        router.push(`/music/playlist/${id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create playlist");
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCreate();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-display text-xs font-semibold tracking-wide text-text-muted">Playlists</h3>

      <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-bg-hover">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pink-500/15 text-pink-400">
          <Heart aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href="/music/favourites" className="block truncate text-sm text-text hover:underline">
            Favourite tracks
          </Link>
          <p className="truncate text-xs text-text-muted">
            {favouriteTrackCount} track{favouriteTrackCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={handlePlayFavourites}
          disabled={favouriteTrackCount === 0 || (pending && playingId === "favourites")}
          aria-label="Play favourite tracks"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-format-digital disabled:opacity-30"
        >
          <PlayIcon className="h-4 w-4" />
        </button>
      </div>

      {playlists.map((playlist) => {
        const isCurrent = snapshot.context?.kind === "playlist" && snapshot.context.playlistId === playlist.id;
        return (
          <div
            key={playlist.id}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-bg-hover"
          >
            <CoverImage
              albumId={playlist.coverAlbumId}
              version={playlist.coverVersion}
              title={playlist.name}
              fallback="glyph"
              className="h-8 w-8 shrink-0 rounded"
            />
            <div className="min-w-0 flex-1">
              <Link
                href={`/music/playlist/${playlist.id}`}
                className={`block truncate text-sm hover:underline ${isCurrent ? "text-format-digital" : "text-text"}`}
              >
                {playlist.name}
              </Link>
              <p className="truncate text-xs text-text-muted">
                {playlist.trackCount} track{playlist.trackCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handlePlayPlaylist(playlist.id, playlist.name)}
              disabled={playlist.trackCount === 0 || (pending && playingId === playlist.id)}
              aria-label={`Play ${playlist.name}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-format-digital disabled:opacity-30"
            >
              <PlayIcon className="h-4 w-4" />
            </button>
          </div>
        );
      })}

      {creating ? (
        <div className="flex flex-col gap-1 px-1.5 py-1">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Playlist name"
              maxLength={PLAYLIST_NAME_MAX}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text outline-none focus:border-format-digital"
            />
            <button
              type="button"
              onClick={submitCreate}
              disabled={pending || name.trim().length === 0}
              className="shrink-0 rounded-md bg-bg-hover px-2 py-1 text-xs font-medium text-text hover:bg-bg-elevated-2 disabled:opacity-30"
            >
              Create
            </button>
          </div>
          {error && <p className="text-missing text-xs">{error}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
        >
          <Plus aria-hidden className="h-4 w-4" />
          New playlist
        </button>
      )}
    </div>
  );
}
