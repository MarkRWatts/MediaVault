"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PhysicalAddResponse {
  id: number;
  title: string;
  artistName: string;
  kind: string;
  year: number | null;
}

interface PhysicalAddError {
  error: string;
}

export default function PhysicalAddForm() {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [discogsUrl, setDiscogsUrl] = useState("");
  const [medium, setMedium] = useState<"VINYL" | "CD">("VINYL");
  const [format, setFormat] = useState("");
  const [catalogNo, setCatalogNo] = useState("");
  const [label, setLabel] = useState("");
  const [pressYear, setPressYear] = useState("");
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const body: Record<string, unknown> = { discogsUrl, medium };

      if (format) body.format = format;
      if (catalogNo) body.catalogNo = catalogNo;
      if (label) body.label = label;
      if (pressYear) body.pressYear = parseInt(pressYear, 10);
      if (condition) body.condition = condition;
      if (notes) body.notes = notes;

      const res = await fetch("/api/physical-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data: PhysicalAddError = await res.json();
        setError(data.error || "Failed to add album");
        return;
      }

      const data: PhysicalAddResponse = await res.json();
      router.push(`/music/album/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-2.5 py-1 font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
      >
        + Add physical-only album
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Add physical-only album</h3>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setError(null);
          }}
          className="text-xs text-text-faint hover:text-text-muted transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="discogsUrl" className="block text-xs font-medium text-text-muted mb-1">
            Discogs release or master URL <span className="text-accent">*</span>
          </label>
          <input
            id="discogsUrl"
            type="text"
            value={discogsUrl}
            onChange={(e) => setDiscogsUrl(e.target.value)}
            placeholder="https://www.discogs.com/release/..."
            required
            className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="medium" className="block text-xs font-medium text-text-muted mb-1">
              Medium
            </label>
            <select
              id="medium"
              value={medium}
              onChange={(e) => setMedium(e.target.value as "VINYL" | "CD")}
              className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text focus-visible:outline-none"
            >
              <option value="VINYL">Vinyl</option>
              <option value="CD">CD</option>
            </select>
          </div>

          <div>
            <label htmlFor="format" className="block text-xs font-medium text-text-muted mb-1">
              Format
            </label>
            <input
              id="format"
              type="text"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder={medium === "VINYL" ? "LP" : "CD"}
              className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
          </div>

          <div>
            <label htmlFor="catalogNo" className="block text-xs font-medium text-text-muted mb-1">
              Catalog No.
            </label>
            <input
              id="catalogNo"
              type="text"
              value={catalogNo}
              onChange={(e) => setCatalogNo(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="label" className="block text-xs font-medium text-text-muted mb-1">
              Label
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
          </div>

          <div>
            <label htmlFor="pressYear" className="block text-xs font-medium text-text-muted mb-1">
              Press year
            </label>
            <input
              id="pressYear"
              type="number"
              value={pressYear}
              onChange={(e) => setPressYear(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="condition" className="block text-xs font-medium text-text-muted mb-1">
            Condition
          </label>
          <input
            id="condition"
            type="text"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. Mint, Near mint, Good"
            className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-xs font-medium text-text-muted mb-1">
            Notes
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional notes..."
            rows={2}
            className="w-full rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
          />
        </div>

        {error && <div className="text-xs text-missing">{error}</div>}
      </div>

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={loading || !discogsUrl}
          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md border border-border px-2.5 py-1 font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
        >
          {loading ? "Adding..." : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setError(null);
          }}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-2.5 py-1 font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text sm:min-h-0"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
