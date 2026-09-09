"use client";

// The /music/playlist/[id] page's body: an inline-renamable header, the
// Play/Shuffle/Delete row, and the reorderable track list. Styled like
// FavouriteTracksView (same divide-y/border list, Play/Shuffle button
// styles, CoverImage/TrackMenu/Volume2 row treatment) plus DeleteAlbumButton's
// confirm dialog for Delete and TrackHeart's optimistic-then-router.refresh()
// pattern for reorder/remove.
//
// `items` and `name` start from the server-fetched `detail` prop but live in
// local state so Play, rename, reorder and remove can update the screen
// immediately; a useEffect re-syncs both whenever `detail` changes (a
// router.refresh() following a mutation elsewhere, e.g. another tab).

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, Pencil, Trash2, Volume2, X } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import TrackMenu from "@/components/player/TrackMenu";
import { PlayIcon, PauseIcon, ShuffleIcon } from "@/components/player/icons";
import { usePlayer } from "@/components/player/usePlayer";
import { formatTime, formatLongTime, formatDateDMY } from "@/lib/format-time";
import { renamePlaylist, deletePlaylist, removePlaylistItem, movePlaylistItem } from "@/app/actions/music-state";
import type { PlaybackContext, QueueTrack } from "@/lib/player-types";
import type { PlaylistDetail, PlaylistItemView } from "@/lib/queries-playlists";

const secondaryChip =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text";

/** Strip the page-only fields so the engine gets plain QueueTracks — same
 *  shape as queries-playlists.ts' toQueueTracks. Duplicated here (rather
 *  than imported) because that module pulls in the Prisma client, which
 *  can't ship in a "use client" bundle. */
function toQueueTracks(items: PlaylistItemView[]): QueueTrack[] {
  return items.map((t) => ({
    trackId: t.trackId,
    title: t.title,
    artist: t.artist,
    albumId: t.albumId,
    albumTitle: t.albumTitle,
    hasCover: t.hasCover,
    coverVersion: t.coverVersion,
    durationSecs: t.durationSecs,
    codec: t.codec,
  }));
}

export default function PlaylistView({ detail }: { detail: PlaylistDetail }) {
  const router = useRouter();
  const { snapshot, engine } = usePlayer();

  const [name, setName] = useState(detail.name);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(detail.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const cancelingNameRef = useRef(false);
  const savingNameRef = useRef(false);

  const [items, setItems] = useState(detail.items);
  const [pending, startTransition] = useTransition();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    // A server refresh (after a mutation elsewhere, e.g. another tab) wins
    // over any optimistic local edit still in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(detail.name);
  }, [detail.name]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(detail.items);
  }, [detail.items]);

  const context: PlaybackContext = { kind: "playlist", playlistId: detail.id, title: name };
  const isThisList = snapshot.context?.kind === "playlist" && snapshot.context.playlistId === detail.id;
  const isPlaying = isThisList && (snapshot.status === "playing" || snapshot.status === "loading");
  const isPaused = isThisList && snapshot.status === "paused";

  const totalSecs = items.reduce((sum, t) => sum + (t.durationSecs ?? 0), 0);

  function handlePlayClick() {
    if (isPlaying) engine.pause();
    else if (isPaused) engine.play();
    else engine.playTracks(toQueueTracks(items), { context });
  }

  function startEditingName() {
    setNameDraft(name);
    setNameError(null);
    setEditingName(true);
  }

  async function saveName() {
    const trimmed = nameDraft.trim();
    if (trimmed === "") {
      setNameError("Name can't be empty");
      setEditingName(true);
      return;
    }
    if (trimmed === name) {
      setEditingName(false);
      return;
    }
    const previous = name;
    setName(trimmed);
    setEditingName(false);
    try {
      const result = await renamePlaylist(detail.id, trimmed);
      setName(result.name);
      router.refresh();
    } catch (err) {
      setName(previous);
      setNameDraft(previous);
      setNameError(err instanceof Error ? err.message : "Rename failed");
      setEditingName(true);
    }
  }

  function onNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Save directly rather than via blur: blur only fires if the input
      // actually held focus, and the save must not depend on that.
      e.preventDefault();
      savingNameRef.current = true;
      void saveName();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      cancelingNameRef.current = true;
      setNameDraft(name);
      setNameError(null);
      e.currentTarget.blur();
    }
  }

  function onNameBlur() {
    if (cancelingNameRef.current) {
      cancelingNameRef.current = false;
      setEditingName(false);
      return;
    }
    if (savingNameRef.current) {
      savingNameRef.current = false; // Enter already saved
      return;
    }
    void saveName();
  }

  function closeConfirm() {
    if (deleting) return;
    setConfirmingDelete(false);
    setDeleteError(null);
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePlaylist(detail.id);
      router.push("/music");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const previous = items;
    const next = items.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setItems(next);
    startTransition(async () => {
      try {
        await movePlaylistItem(detail.id, moved.itemId, target);
        router.refresh();
      } catch {
        setItems(previous);
      }
    });
  }

  function handleRemove(item: PlaylistItemView) {
    const previous = items;
    setItems(items.filter((x) => x.itemId !== item.itemId));
    startTransition(async () => {
      try {
        await removePlaylistItem(detail.id, item.itemId);
        router.refresh();
      } catch {
        setItems(previous);
      }
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="border-b border-border pb-6">
        {editingName ? (
          <input
            autoFocus
            maxLength={80}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={onNameKeyDown}
            onBlur={onNameBlur}
            aria-label="Playlist name"
            className="mt-2 w-full max-w-md rounded-md border border-border-strong bg-bg-elevated px-2 py-1 font-display text-3xl tracking-wide text-text focus:outline-none focus:ring-1 focus:ring-format-digital"
          />
        ) : (
          <button
            type="button"
            onClick={startEditingName}
            aria-label="Rename playlist"
            className="group mt-2 flex max-w-full items-center gap-2 text-left"
          >
            <span className="truncate font-display text-3xl tracking-wide text-text">{name}</span>
            <Pencil
              aria-hidden
              className="h-4 w-4 shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        )}
        {nameError && <p className="mt-1 text-xs text-missing">{nameError}</p>}

        <p className="mt-1 font-mono text-xs text-text-faint">
          {items.length} track{items.length === 1 ? "" : "s"} · {formatLongTime(totalSecs)}
        </p>
        <p className="font-mono text-xs text-text-faint">
          Created {formatDateDMY(detail.createdAt)}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handlePlayClick}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="inline-flex items-center gap-2 rounded-full border border-format-digital-border bg-format-digital-bg px-5 py-2.5 text-sm font-semibold tracking-wide text-format-digital transition-colors hover:bg-format-digital/25"
          >
            {isPlaying ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            {isPlaying ? "Pause" : "Play"}
          </button>

          <button
            type="button"
            onClick={() => engine.playTracks(toQueueTracks(items), { context, shuffle: true })}
            aria-label="Shuffle"
            className={secondaryChip}
          >
            <ShuffleIcon className="h-3.5 w-3.5" />
            Shuffle
          </button>

          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label="Delete playlist"
            className="inline-flex items-center gap-1.5 rounded-full border border-missing-border px-3 py-1.5 text-xs font-medium tracking-wide text-missing transition-colors hover:bg-missing-bg"
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-text-faint">
          This playlist is empty — use &ldquo;Add to playlist&rdquo; from any track&rsquo;s … menu.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
          {items.map((t, i) => {
            const isCurrent = snapshot.current?.trackId === t.trackId;
            return (
              <li key={t.itemId} className="group flex items-center gap-3 px-3 py-2">
                <span className="w-5 shrink-0 text-right font-mono text-xs text-text-faint">{i + 1}</span>
                <CoverImage
                  albumId={t.hasCover ? t.albumId : null}
                  version={t.coverVersion}
                  title={t.albumTitle}
                  fallback="glyph"
                  className="h-8 w-8 shrink-0 rounded"
                />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => engine.playTracks(toQueueTracks(items), { startIndex: i, context })}
                    aria-label={`Play ${t.title}`}
                    className="flex max-w-full items-center gap-1.5 text-left text-sm hover:underline"
                  >
                    {isCurrent && <Volume2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-format-digital" />}
                    <span className={`truncate ${isCurrent ? "text-format-digital" : "text-text"}`}>{t.title}</span>
                  </button>
                  <p className="truncate text-xs text-text-muted">
                    {t.artist} ·{" "}
                    <Link href={`/music/album/${t.albumId}`} className="hover:text-text hover:underline">
                      {t.albumTitle}
                    </Link>
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-text-faint">{formatTime(t.durationSecs)}</span>
                <TrackMenu tracks={[t]} label={t.title} context={context} size="sm" />
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    disabled={pending || i === 0}
                    onClick={() => handleMove(i, -1)}
                    aria-label={`Move ${t.title} up`}
                    className="p-1 text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronUp aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={pending || i === items.length - 1}
                    onClick={() => handleMove(i, 1)}
                    aria-label={`Move ${t.title} down`}
                    className="p-1 text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronDown aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleRemove(t)}
                    aria-label={`Remove ${t.title} from playlist`}
                    className="p-1 text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirmingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-playlist-heading"
          onClick={closeConfirm}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeConfirm();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-bg-elevated p-6 shadow-lg shadow-black/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="delete-playlist-heading" className="font-display text-lg tracking-wide text-text">
                Delete &ldquo;{name}&rdquo;?
              </h2>
              <button
                type="button"
                onClick={closeConfirm}
                aria-label="Cancel"
                className="shrink-0 text-text-faint transition-colors hover:text-text"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-text-muted">This can&rsquo;t be undone.</p>
            {deleteError && <p className="text-sm text-missing">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeConfirm}
                disabled={deleting}
                className="inline-flex min-h-10 items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing px-4 py-2 text-sm font-medium text-missing shadow-sm transition-colors hover:bg-missing-bg disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
