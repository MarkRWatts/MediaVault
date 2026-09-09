"use client";

// The playlist chooser shared by TrackMenu's "Add to playlist ▸" submenu
// and AlbumActions' own popover: list every playlist from usePlaylists(),
// a "New playlist…" row that turns into a one-line create form, and a
// brief status line before the caller closes the panel (onDone). Escape
// handling is local — "back" one level (form → list, or list → onBack)
// rather than closing outright — so the host panel's own Escape listener
// only fires once there is nowhere left to go back to.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { usePlaylists } from "./PlaylistsContext";
import { addTracksToPlaylist, createPlaylist } from "@/app/actions/music-state";

const menuItem =
  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-text hover:bg-bg-hover disabled:cursor-default disabled:opacity-40";

const STATUS_MS = 1500;

export default function AddToPlaylistMenu({
  trackIds,
  onDone,
  onBack,
}: {
  trackIds: number[];
  /** Called once the status line has shown for ~1.5s — the host closes its panel. */
  onDone: () => void;
  /** Present only when this list sits inside a bigger menu (TrackMenu's
   *  submenu view); its own "‹ Back" row and Escape-back use it. */
  onBack?: () => void;
}) {
  const { playlists } = usePlaylists();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  function showStatus(message: string) {
    setStatus(message);
    timeoutRef.current = setTimeout(onDone, STATUS_MS);
  }

  function describe(result: { added: number; skipped: number }): string {
    if (result.added === 0) return "Already in playlist";
    return `Added ${result.added} track${result.added === 1 ? "" : "s"}`;
  }

  function addTo(playlistId: number) {
    startTransition(async () => {
      try {
        const result = await addTracksToPlaylist(playlistId, trackIds);
        router.refresh();
        showStatus(describe(result));
      } catch (err) {
        showStatus(err instanceof Error ? err.message : "Could not add tracks");
      }
    });
  }

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      try {
        const { id } = await createPlaylist(trimmed);
        const result = await addTracksToPlaylist(id, trackIds);
        router.refresh();
        showStatus(describe(result));
      } catch (err) {
        showStatus(err instanceof Error ? err.message : "Could not create playlist");
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (creating) {
      e.stopPropagation();
      setCreating(false);
      return;
    }
    // With nowhere of our own to go back to, let the host's Escape
    // listener (which closes the whole panel) see the event.
    if (onBack) {
      e.stopPropagation();
      onBack();
    }
  }

  return (
    <div className="flex flex-col gap-0.5" onKeyDown={handleKeyDown}>
      {!creating && (
        <>
          {onBack && (
            <button
              type="button"
              role="menuitem"
              disabled={pending || status !== null}
              onClick={(e) => {
                e.stopPropagation();
                onBack();
              }}
              className={menuItem}
            >
              ‹ Back
            </button>
          )}
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {playlists.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                disabled={pending || status !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  addTo(p.id);
                }}
                className={`${menuItem} w-full justify-between`}
              >
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-text-muted">{p.trackCount} tracks</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={pending || status !== null}
            onClick={(e) => {
              e.stopPropagation();
              setCreating(true);
            }}
            className={menuItem}
          >
            New playlist…
          </button>
        </>
      )}

      {creating && (
        <input
          ref={inputRef}
          type="text"
          value={name}
          placeholder="Playlist name"
          disabled={pending || status !== null}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleCreate();
            }
            // Escape is handled by the wrapping onKeyDown above.
          }}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent-border disabled:opacity-40"
        />
      )}

      {status && <div className="px-3 py-2 text-xs text-text-muted">{status}</div>}
    </div>
  );
}
