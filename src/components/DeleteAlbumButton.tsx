"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Deletes the whole Album row (not just one PhysicalCopy — see
// PhysicalCopyForm's "Remove", which only unlinks a medium) — for a
// physical-only placeholder that shouldn't exist at all, e.g. a "paste
// Discogs links" add that anchored to the wrong MusicBrainz release-group.
// Irreversible (no undo, unlike a PhysicalCopy removal which can just be
// re-added), so this gets its own confirmation dialog rather than a plain
// button — styled after RemoveMemberButton's modal.
export default function DeleteAlbumButton({
  albumId,
  title,
  artistId,
}: {
  albumId: number;
  title: string;
  artistId: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (deleting) return;
    setOpen(false);
    setError(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/album/${albumId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      router.push(`/music/artist/${artistId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-missing-border px-3 py-1 text-xs font-medium text-missing transition-colors hover:bg-missing-bg sm:min-h-0"
      >
        Delete album
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-album-heading"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-bg-elevated p-6 shadow-lg shadow-black/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="delete-album-heading" className="font-display text-lg tracking-wide text-text">
                Delete &ldquo;{title}&rdquo;?
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Cancel"
                className="shrink-0 text-text-faint transition-colors hover:text-text"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-text-muted">
              Removes this album record entirely — its physical copies and any linked pressing data go with it.
              This can&rsquo;t be undone; you&rsquo;d need to re-add it from scratch.
            </p>
            {error && <p className="text-sm text-missing">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
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
    </>
  );
}
