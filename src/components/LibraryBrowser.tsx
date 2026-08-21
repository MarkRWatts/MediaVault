"use client";

import { useMemo, useState } from "react";
import FilmCard from "@/components/FilmCard";
import type { LibraryFilm } from "@/lib/queries";

type FilterKey = "all" | "bluray" | "dvd" | "collection" | "noposter";
type SortKey = "title" | "year" | "added";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "bluray", label: "Blu-ray" },
  { key: "dvd", label: "DVD" },
  { key: "collection", label: "In a collection" },
  { key: "noposter", label: "No poster" },
];

export default function LibraryBrowser({ films }: { films: LibraryFilm[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("title");

  const filtered = useMemo(() => {
    let list = films;

    if (filter === "bluray") list = list.filter((f) => f.formats.includes("BLURAY"));
    else if (filter === "dvd") list = list.filter((f) => f.formats.includes("DVD"));
    else if (filter === "collection") list = list.filter((f) => f.collectionId !== null);
    else if (filter === "noposter") list = list.filter((f) => !f.posterPath);

    const q = query.trim().toLowerCase();
    if (q) list = list.filter((f) => f.title.toLowerCase().includes(q));

    const sorted = [...list];
    if (sort === "title") sorted.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    else if (sort === "year") sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return sorted;
  }, [films, filter, query, sort]);

  if (films.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <p className="font-display text-2xl tracking-wide text-text-muted">
          No films yet
        </p>
        <p className="max-w-sm text-sm text-text-faint">
          Run a scan from the admin strip in the top-right to index your collection.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <circle cx="9" cy="9" r="6" />
              <path d="M17 17l-4-4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles…"
              aria-label="Search titles"
              className="w-full rounded-md border border-border bg-bg-elevated py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-faint focus-visible:outline-none sm:w-56"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors ${
                  filter === f.key
                    ? "border-accent-border bg-accent-dim text-accent"
                    : "border-border text-text-muted hover:border-border-strong hover:text-text"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value="title">Title</option>
              <option value="year">Year</option>
              <option value="added">Recently added</option>
            </select>
          </label>
        </div>
      </div>

      <p className="text-xs text-text-faint">
        {filtered.length === films.length ? (
          <>
            {films.length} film{films.length === 1 ? "" : "s"}
          </>
        ) : (
          <>
            {filtered.length} of {films.length} films
          </>
        )}
      </p>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-24 text-center">
          <p className="text-sm text-text-muted">No films match.</p>
          <p className="text-xs text-text-faint">Try a different search or filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
          {filtered.map((film) => (
            <FilmCard key={film.id} film={film} />
          ))}
        </div>
      )}
    </div>
  );
}
