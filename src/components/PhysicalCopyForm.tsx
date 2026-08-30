"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PhysicalCopyView } from "@/lib/queries-music";

const MEDIUM_LABEL: Record<string, string> = { VINYL: "vinyl", CD: "CD" };

// One physical copy — editable in place if `initial` is set, or a blank
// "add a copy" form otherwise. Multiple copies of the same medium are legal
// (an original pressing and a later reissue, say), so this no longer
// upserts by (albumId, medium) — see POST /api/physical.
export default function PhysicalCopyForm({
  albumId,
  medium,
  initial,
  onDone,
}: {
  albumId: number;
  medium: "VINYL" | "CD";
  initial: PhysicalCopyView | null;
  /** Called after a successful create, so the parent can close the "add
   *  another" form — edits stay open in place. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [format, setFormat] = useState(initial?.format ?? (medium === "VINYL" ? "LP" : "CD"));
  const [catalogNo, setCatalogNo] = useState(initial?.catalogNo ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [pressYear, setPressYear] = useState(initial?.pressYear?.toString() ?? "");
  const [condition, setCondition] = useState(initial?.condition ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [discogsRef, setDiscogsRef] = useState("");
  const [rechecking, setRechecking] = useState(false);

  const mediumLabel = MEDIUM_LABEL[medium] ?? medium.toLowerCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch("/api/physical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: initial?.id,
          albumId,
          medium,
          format: format || undefined,
          catalogNo: catalogNo || undefined,
          label: label || undefined,
          pressYear: pressYear ? Number(pressYear) : undefined,
          condition: condition || undefined,
          notes: notes || undefined,
          discogsRef: discogsRef || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.trackImportError) {
        setError(`Saved, but couldn't link that release: ${data.trackImportError}`);
      } else {
        if (!initial) {
          // This is the persistent "+ Add another copy" instance — it stays
          // mounted (same position in the tree) across the router.refresh()
          // below, so its field state must be reset by hand or a second add
          // would silently reopen pre-filled with this submission's values.
          setFormat(medium === "VINYL" ? "LP" : "CD");
          setCatalogNo("");
          setLabel("");
          setPressYear("");
          setCondition("");
          setNotes("");
          onDone?.();
        }
        setIsOpen(false);
      }
      setDiscogsRef("");
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
      const res = await fetch(`/api/physical?id=${initial.id}`, { method: "DELETE" });

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

  // Re-query Discogs from this copy's own already-stored barcode — a
  // strong but not infallible anchor (a barcode can legitimately be shared
  // across colour-vinyl/regional variants), so this only pre-fills the link
  // field for confirmation rather than auto-applying the result.
  const handleRecheckBarcode = async () => {
    if (!initial?.barcode) return;
    setError(null);
    setRechecking(true);
    try {
      const res = await fetch("/api/barcode/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: initial.barcode, type: "album" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.status === "not_owned" && data.type === "album" && data.candidate.discogsReleaseId) {
        setDiscogsRef(`https://www.discogs.com/release/${data.candidate.discogsReleaseId}`);
        setIsOpen(true);
      } else {
        setError("No Discogs match found for this barcode.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setRechecking(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsOpen(true)}
          className="rounded border border-border px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
        >
          {initial
            ? initial.inferred
              ? `Confirm ${mediumLabel} copy`
              : `Edit ${mediumLabel} copy`
            : `+ Add ${mediumLabel} copy`}
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
        {initial?.barcode && (
          <button
            onClick={handleRecheckBarcode}
            disabled={rechecking}
            className="rounded border border-border px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {rechecking ? "Checking…" : "Re-check via barcode"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Format</label>
            <input
              type="text"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder={medium === "VINYL" ? "LP" : "CD"}
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Cat#</label>
            <input
              type="text"
              value={catalogNo}
              onChange={(e) => setCatalogNo(e.target.value)}
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-1">
            <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Year</label>
            <input
              type="number"
              value={pressYear}
              onChange={(e) => setPressYear(e.target.value)}
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Condition</label>
          <input
            type="text"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. VG+, Mint"
            className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Notes</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
          />
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <label className="text-xs font-medium uppercase tracking-widest text-text-muted">
            Link a specific pressing (optional)
          </label>
          <input
            type="text"
            value={discogsRef}
            onChange={(e) => setDiscogsRef(e.target.value)}
            placeholder="discogs.com/release/... — pulls this pressing's own tracklist & cover"
            className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
          />
          {initial && initial.tracks.length > 0 && (
            <p className="text-xs text-text-faint">
              Linked via Discogs: {initial.tracks.length} track
              {initial.tracks.length === 1 ? "" : "s"}
              {initial.hasCover ? ", own cover art" : ""}
              {initial.discogsUrl && (
                <>
                  {" — "}
                  <a href={initial.discogsUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    view on Discogs
                  </a>
                </>
              )}
            </p>
          )}
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
