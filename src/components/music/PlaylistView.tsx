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
import { ChevronDown, ChevronUp, GripVertical, Pencil, Trash2, Volume2, X } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import TrackMenu from "@/components/player/TrackMenu";
import { PlayIcon, PauseIcon, ShuffleIcon } from "@/components/player/icons";
import { usePlayer } from "@/components/player/usePlayer";
import { formatTime, formatLongTime, formatDateDMY } from "@/lib/format-time";
import {
  renamePlaylist,
  deletePlaylist,
  removePlaylistItem,
  movePlaylistItem,
  reorderPlaylistItems,
} from "@/app/actions/music-state";
import type { PlaybackContext, QueueTrack } from "@/lib/player-types";
import type { PlaylistDetail, PlaylistItemView } from "@/lib/queries-playlists";

/** Where a drag-and-drop reorder would land: `index` into the current
 *  `items` array, and which edge of that row. */
interface DropIndicator {
  index: number;
  edge: "before" | "after";
}

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

  // Multi-select drag-and-drop reorder: click a row's grip handle to
  // select it (shift-click extends a range from the last-clicked row,
  // cmd/ctrl-click toggles one row), then drag any selected handle to
  // move the whole selection as a group — same interaction as a file
  // manager's list view. Dragging an unselected row drags just that row.
  // Native HTML5 drag-and-drop, no library (see PLAYLISTS_PLAN.md).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchorIndexRef = useRef<number | null>(null);
  // Sends a drag to `onDragStart` only when it actually began on a grip
  // handle — `draggable` has to live on the whole <li> (so the browser's
  // default drag image is the full row, not just the tiny icon), so
  // without this gate a drag started from the title or cover would also
  // fire.
  const allowDragRef = useRef(false);
  const dragIdsRef = useRef<number[]>([]);
  const [draggingIds, setDraggingIds] = useState<Set<number> | null>(null);
  // The authoritative copy handleDrop reads is the ref: React state from
  // the immediately-preceding dragover isn't guaranteed to have committed
  // yet by the time drop fires (they're separate native events). The
  // state twin only drives the visual indicator line.
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

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

  useEffect(() => {
    // Drop any selected ids a server refresh removed from the list (e.g.
    // removed in another tab) so drag/select never references a stale id.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((prev) => {
      const validIds = new Set(items.map((it) => it.itemId));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    function clearSelection() {
      setSelected((prev) => (prev.size === 0 ? prev : new Set()));
    }
    function onPointerDown(e: PointerEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) clearSelection();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") clearSelection();
    }
    // Belt-and-braces: a drag that ends outside any row's onDrop (e.g.
    // dropped off the list entirely) still needs the grab gate reset.
    function onWindowMouseUp() {
      allowDragRef.current = false;
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
  }, []);

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

  function handleGripClick(e: React.MouseEvent, item: PlaylistItemView, index: number) {
    if (e.shiftKey && anchorIndexRef.current !== null) {
      const [lo, hi] = [anchorIndexRef.current, index].sort((a, b) => a - b);
      setSelected(new Set(items.slice(lo, hi + 1).map((it) => it.itemId)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.itemId)) next.delete(item.itemId);
        else next.add(item.itemId);
        return next;
      });
      anchorIndexRef.current = index;
    } else {
      setSelected(new Set([item.itemId]));
      anchorIndexRef.current = index;
    }
  }

  function handleDragStart(e: React.DragEvent<HTMLLIElement>, item: PlaylistItemView) {
    if (!allowDragRef.current) {
      e.preventDefault();
      return;
    }
    allowDragRef.current = false;
    const ids = selected.has(item.itemId)
      ? items.filter((it) => selected.has(it.itemId)).map((it) => it.itemId)
      : [item.itemId];
    if (!selected.has(item.itemId)) setSelected(new Set(ids));
    dragIdsRef.current = ids;
    setDraggingIds(new Set(ids));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(item.itemId));
  }

  function handleDragOver(e: React.DragEvent<HTMLLIElement>, index: number) {
    if (dragIdsRef.current.length === 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Hovering one of the rows being dragged itself has no sensible drop
    // meaning — keep whatever indicator was last shown over a real target.
    if (dragIdsRef.current.includes(items[index].itemId)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: "before" | "after" = e.clientY - rect.top < rect.height / 2 ? "before" : "after";
    dropIndicatorRef.current = { index, edge };
    setDropIndicator({ index, edge });
  }

  function clearDragState() {
    allowDragRef.current = false;
    dragIdsRef.current = [];
    dropIndicatorRef.current = null;
    setDraggingIds(null);
    setDropIndicator(null);
  }

  function handleDrop(e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
    const draggedIds = dragIdsRef.current;
    const indicator = dropIndicatorRef.current;
    clearDragState();
    if (draggedIds.length === 0 || !indicator) return;

    const draggedSet = new Set(draggedIds);
    const remaining = items.filter((it) => !draggedSet.has(it.itemId));
    const draggedInOrder = items.filter((it) => draggedSet.has(it.itemId));

    // Map the drop target — an index into the full `items` array — to an
    // index into `remaining` (the same list with the dragged rows pulled
    // out), since that's what's actually being spliced back together.
    const targetItem = items[indicator.index];
    let insertAt = remaining.length;
    if (targetItem && !draggedSet.has(targetItem.itemId)) {
      const idx = remaining.findIndex((it) => it.itemId === targetItem.itemId);
      insertAt = indicator.edge === "before" ? idx : idx + 1;
    }

    const next = remaining.slice();
    next.splice(insertAt, 0, ...draggedInOrder);
    if (next.length === items.length && next.every((it, i) => it.itemId === items[i].itemId)) return;

    const previous = items;
    setItems(next);
    startTransition(async () => {
      try {
        await reorderPlaylistItems(
          detail.id,
          next.map((it) => it.itemId),
        );
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
        <>
          {items.length > 1 && (
            <p className="-mb-2 font-mono text-[11px] text-text-faint">
              Drag the grip to reorder — shift/cmd-click to select several rows first.
            </p>
          )}
          <ul
            ref={listRef}
            className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated"
          >
            {items.map((t, i) => {
              const isCurrent = snapshot.current?.trackId === t.trackId;
              const isSelected = selected.has(t.itemId);
              const isDragging = draggingIds?.has(t.itemId) ?? false;
              const showBefore = dropIndicator?.index === i && dropIndicator.edge === "before";
              const showAfter = dropIndicator?.index === i && dropIndicator.edge === "after";
              return (
                <li
                  key={t.itemId}
                  draggable
                  onDragStart={(e) => handleDragStart(e, t)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={handleDrop}
                  onDragEnd={clearDragState}
                  className={`group relative flex items-center gap-3 px-3 py-2 transition-colors ${
                    isSelected ? "bg-format-digital/10" : ""
                  } ${isDragging ? "opacity-40" : ""}`}
                >
                  {showBefore && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-3 top-0 h-0.5 -translate-y-px rounded-full bg-format-digital"
                    />
                  )}
                  {showAfter && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-3 bottom-0 h-0.5 translate-y-px rounded-full bg-format-digital"
                    />
                  )}
                  <button
                    type="button"
                    onMouseDown={() => {
                      allowDragRef.current = true;
                    }}
                    onClick={(e) => handleGripClick(e, t, i)}
                    aria-label={`Select ${t.title}`}
                    aria-pressed={isSelected}
                    className="shrink-0 cursor-grab touch-none p-1 text-text-faint transition-colors hover:text-text active:cursor-grabbing"
                  >
                    <GripVertical aria-hidden className="h-4 w-4" />
                  </button>
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
                      <span className={`truncate ${isCurrent ? "text-format-digital" : "text-text"}`}>
                        {t.title}
                      </span>
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
        </>
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
