"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VinylView } from "@/lib/queries-music";

export default function VinylForm({ albumId, initial }: { albumId: number; initial: VinylView | null }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [format, setFormat] = useState(initial?.format ?? "LP");
  const [catalogNo, setCatalogNo] = useState(initial?.catalogNo ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [pressYear, setPressYear] = useState(initial?.pressYear?.toString() ?? "");
  const [condition, setCondition] = useState(initial?.condition ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch("/api/vinyl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          albumId,
          format: format || undefined,
          catalogNo: catalogNo || undefined,
          label: label || undefined,
          pressYear: pressYear ? Number(pressYear) : undefined,
          condition: condition || undefined,
          notes: notes || undefined,
        }),
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
      const res = await fetch(`/api/vinyl?albumId=${albumId}`, {
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
          {initial ? "Edit vinyl copy" : "+ Add vinyl copy"}
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-widest text-text-muted">Format</label>
            <input
              type="text"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder="LP"
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
