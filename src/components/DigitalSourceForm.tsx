"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DIGITAL_SOURCES, DIGITAL_SOURCE_LABELS, type DigitalSource } from "@/lib/digital-source";

// Compact provenance selector for the album page: where did this album's
// digital files come from? Saves via POST /api/digital-source on change.
export default function DigitalSourceForm({
  albumId,
  initial,
}: {
  albumId: number;
  initial: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleChange = async (next: string) => {
    setValue(next);
    setError(null);
    setIsSaving(true);
    try {
      const res = await fetch("/api/digital-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ albumId, source: next === "" ? null : next }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setValue(initial ?? "");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="digital-source" className="text-xs font-medium text-text-muted">
        Digital source
      </label>
      <select
        id="digital-source"
        value={value}
        disabled={isSaving}
        onChange={(e) => handleChange(e.target.value)}
        className="w-fit rounded border border-border bg-bg-elevated px-2 py-1 text-xs text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        <option value="">Unconfirmed</option>
        {DIGITAL_SOURCES.map((s: DigitalSource) => (
          <option key={s} value={s}>
            {DIGITAL_SOURCE_LABELS[s]}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-missing">{error}</span>}
    </div>
  );
}
