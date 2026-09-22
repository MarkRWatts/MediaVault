"use client";

// The card grid for /music/albums, plus its search box — a client
// component so filtering by title/artist is instant. The list is at most a
// few thousand rows (getPlayableAlbums has no paging either), so a plain
// in-memory filter is all this needs; no debounce, no server round trip.

import { useMemo, useState } from "react";
import Link from "next/link";
import CoverImage from "@/components/CoverImage";
import type { FavouriteAlbumView } from "@/lib/queries-music";

function AlbumCard({ album }: { album: FavouriteAlbumView }) {
  return (
    <Link
      href={`/music/album/${album.id}`}
      className="hover-lift block overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <CoverImage
        albumId={album.hasCover ? album.id : null}
        version={album.coverVersion}
        title={album.title}
        className="w-full"
      />
      <div className="flex flex-col gap-0.5 p-2.5">
        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-text">{album.title}</h3>
        <span className="text-[11px] text-text-faint">
          {album.artistName}
          {album.year != null ? ` · ${album.year}` : ""}
        </span>
      </div>
    </Link>
  );
}

const GRID = "grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5 @5xl:grid-cols-6";

export default function AlbumsGrid({ albums }: { albums: FavouriteAlbumView[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => a.title.toLowerCase().includes(q) || a.artistName.toLowerCase().includes(q));
  }, [albums, query]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="relative sm:w-64">
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
          placeholder="Search albums…"
          aria-label="Search albums"
          className="w-full rounded-md border border-border bg-bg-elevated py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-text-faint">
          {albums.length === 0 ? "No playable albums yet." : `No albums match "${query}".`}
        </p>
      ) : (
        <div className={GRID}>
          {filtered.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      )}
    </div>
  );
}
