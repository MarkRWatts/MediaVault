"use client";

import { useMemo, useState } from "react";
import FilmCard from "@/components/FilmCard";
import StackedFilmCard from "@/components/StackedFilmCard";
import { videoCodecLabel } from "@/lib/constants";
import type { LibraryFilm } from "@/lib/queries";

type FilterKey = "all" | "4k" | "bluray" | "dvd" | "collection" | "noposter";
type SortKey = "title" | "year" | "added";
const ALL_CODECS = "all";

type DisplayItem =
  | { kind: "film"; film: LibraryFilm; sortTitle: string; year: number; addedAt: number }
  | {
      kind: "collection";
      collectionId: number;
      collectionName: string;
      films: LibraryFilm[];
      sortTitle: string;
      year: number;
      addedAt: number;
    };

// Chronological order within a collection: release date, falling back to year.
function byRelease(a: LibraryFilm, b: LibraryFilm): number {
  if (a.releaseDate && b.releaseDate) return a.releaseDate.localeCompare(b.releaseDate);
  return (a.year ?? 0) - (b.year ?? 0);
}

// Groups films that share a collection into contiguous, chronologically
// ordered blocks, so a franchise reads as a run rather than being scattered
// by title/year/added-date sort. Each group carries representative sort keys
// (its most notable member) so the group slots into the list naturally.
function buildDisplayItems(films: LibraryFilm[]): DisplayItem[] {
  const byCollection = new Map<number, LibraryFilm[]>();
  for (const f of films) {
    if (f.collectionId === null) continue;
    const list = byCollection.get(f.collectionId) ?? [];
    list.push(f);
    byCollection.set(f.collectionId, list);
  }

  const items: DisplayItem[] = [];
  const seenCollections = new Set<number>();

  for (const f of films) {
    if (f.collectionId !== null && (byCollection.get(f.collectionId)?.length ?? 0) > 1) {
      if (seenCollections.has(f.collectionId)) continue;
      seenCollections.add(f.collectionId);
      const members = [...byCollection.get(f.collectionId)!].sort(byRelease);
      items.push({
        kind: "collection",
        collectionId: f.collectionId,
        collectionName: f.collectionName ?? "Collection",
        films: members,
        sortTitle: members.reduce((min, m) => (m.sortTitle < min ? m.sortTitle : min), members[0].sortTitle),
        year: members.reduce((max, m) => Math.max(max, m.year ?? 0), 0),
        addedAt: members.reduce((max, m) => Math.max(max, new Date(m.createdAt).getTime()), 0),
      });
    } else {
      items.push({
        kind: "film",
        film: f,
        sortTitle: f.sortTitle,
        year: f.year ?? 0,
        addedAt: new Date(f.createdAt).getTime(),
      });
    }
  }

  return items;
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "4k", label: "4K" },
  { key: "bluray", label: "Blu-ray" },
  { key: "dvd", label: "DVD" },
  { key: "collection", label: "In a collection" },
  { key: "noposter", label: "No poster" },
];

export default function LibraryBrowser({ films }: { films: LibraryFilm[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [videoCodec, setVideoCodec] = useState(ALL_CODECS);
  const [audioFormat, setAudioFormat] = useState(ALL_CODECS);
  const [sort, setSort] = useState<SortKey>("title");
  const [stack, setStack] = useState(true);

  const videoCodecOptions = useMemo(() => {
    const set = new Set<string>();
    films.forEach((f) => f.videoCodecs.forEach((c) => set.add(c)));
    return Array.from(set).sort((a, b) => videoCodecLabel(a).localeCompare(videoCodecLabel(b)));
  }, [films]);

  const audioFormatOptions = useMemo(() => {
    const set = new Set<string>();
    films.forEach((f) => f.audioFormats.forEach((a) => set.add(a)));
    return Array.from(set).sort();
  }, [films]);

  const filtered = useMemo(() => {
    let list = films;

    if (filter === "4k")
      list = list.filter((f) => f.formats.includes("UHD") || f.bestTier.rank === 0);
    else if (filter === "bluray") list = list.filter((f) => f.formats.includes("BLURAY"));
    else if (filter === "dvd") list = list.filter((f) => f.formats.includes("DVD"));
    else if (filter === "collection") list = list.filter((f) => f.collectionId !== null);
    else if (filter === "noposter") list = list.filter((f) => !f.posterPath);

    if (videoCodec !== ALL_CODECS) list = list.filter((f) => f.videoCodecs.includes(videoCodec));
    if (audioFormat !== ALL_CODECS)
      list = list.filter((f) => f.audioFormats.includes(audioFormat));

    const q = query.trim().toLowerCase();
    if (q) list = list.filter((f) => f.title.toLowerCase().includes(q));

    return list;
  }, [films, filter, videoCodec, audioFormat, query]);

  const displayItems = useMemo(() => {
    const items = buildDisplayItems(filtered);
    const sorted = [...items];
    if (sort === "title") sorted.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    else if (sort === "year") sorted.sort((a, b) => b.year - a.year);
    else sorted.sort((a, b) => b.addedAt - a.addedAt);
    return sorted;
  }, [filtered, sort]);

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
                className={`inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 ${
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

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Video
            <select
              value={videoCodec}
              onChange={(e) => setVideoCodec(e.target.value)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value={ALL_CODECS}>All</option>
              {videoCodecOptions.map((c) => (
                <option key={c} value={c}>
                  {videoCodecLabel(c)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Audio
            <select
              value={audioFormat}
              onChange={(e) => setAudioFormat(e.target.value)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value={ALL_CODECS}>All</option>
              {audioFormatOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

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

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={stack}
              onChange={(e) => setStack(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-accent"
            />
            Stack collections
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
          {displayItems.map((item) =>
            item.kind === "film" ? (
              <FilmCard key={item.film.id} film={item.film} />
            ) : stack ? (
              <StackedFilmCard
                key={`c${item.collectionId}`}
                collectionId={item.collectionId}
                collectionName={item.collectionName}
                films={item.films}
              />
            ) : (
              item.films.map((film) => <FilmCard key={film.id} film={film} />)
            ),
          )}
        </div>
      )}
    </div>
  );
}
