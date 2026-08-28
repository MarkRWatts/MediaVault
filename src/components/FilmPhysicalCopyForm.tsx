"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FilmPhysicalCopyView } from "@/lib/queries";
import { formatLabel } from "@/lib/constants";

export default function FilmPhysicalCopyForm({
  filmId,
  medium,
  initial,
}: {
  filmId: number;
  medium: "DVD" | "BLURAY" | "UHD";
  initial: FilmPhysicalCopyView | null;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const mediumLabel = formatLabel(medium);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch("/api/film-physical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filmId, medium, notes: notes || undefined }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!initial) return;
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch(`/api/film-physical?filmId=${filmId}&medium=${medium}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsOpen(true)}
          className="rounded border border-border px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
        >
          {initial ? `Edit ${mediumLabel} copy` : `+ Add ${mediumLabel} copy`}
        </button>
        {initial && (
          <button
            onClick={handleRemove}
            disabled={isSaving}
            className="rounded border border-missing-border px-2 py-1 text-xs font-medium text-missing transition-colors hover:bg-missing-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {initial?.barcode && (
          <p className="font-mono text-xs text-text-faint">Scanned barcode: {initial.barcode}</p>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Notes</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
          />
        </div>

        {error && <p className="text-xs text-missing">{error}</p>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={isSaving}
            className="rounded border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="rounded border border-border px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
