"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Corrects a mismatched album's identity by pasting the right discogs.com
// release/master URL — the user-supplied URL is treated as AUTHORITATIVE:
// it overrides the album's current metadata/cover AND resets every physical
// copy's pressing-level Discogs links, since those were resolved under the
// old (possibly wrong) identity (see applyManualAlbumDiscogsMatch in
// src/lib/discogs.ts). Only shown for owned albums — an unowned placeholder
// is corrected by deleting it and letting the next enrich run recreate it.
export default function FixAlbumMatchForm({
  albumId,
  currentDiscogsUrl,
}: {
  albumId: number;
  currentDiscogsUrl: string | null;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [discogsUrl, setDiscogsUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch("/api/album-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ albumId, discogsUrl }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setIsOpen(false);
      setDiscogsUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply match");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-fit text-xs font-medium text-text-muted hover:text-text"
        >
          Wrong match? Fix with a Discogs link
        </button>
        {currentDiscogsUrl && (
          <a href={currentDiscogsUrl} target="_blank" rel="noreferrer" className="w-fit text-xs text-text-faint hover:text-accent">
            Currently matched via Discogs
          </a>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4">
      <label className="text-xs font-medium uppercase tracking-widest text-text-muted">
        Correct Discogs release or master URL
      </label>
      <p className="text-xs text-text-faint">
        Overrides this album&rsquo;s title/year/cover AND every physical copy&rsquo;s pressing links — they&rsquo;ll
        need re-linking against the corrected identity.
      </p>
      <input
        type="text"
        value={discogsUrl}
        onChange={(e) => setDiscogsUrl(e.target.value)}
        placeholder="https://www.discogs.com/release/..."
        className="rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder-text-faint"
        autoFocus
      />
      {error && <p className="text-xs text-missing">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isSaving || !discogsUrl.trim()}
          className="rounded border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSaving ? "Applying…" : "Apply correction"}
        </button>
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setError(null);
          }}
          className="rounded border border-border px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
