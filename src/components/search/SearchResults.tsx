"use client";

// The Search page's field and results (src/app/search/page.tsx): films,
// shows, artists and albums matching what's typed, each in its own grid —
// the iPhone app's SearchView, section for section. The query is mirrored
// into the address bar (?q=) without a navigation, so Back and reload keep
// it.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import PosterImage from "@/components/PosterImage";
import CoverImage from "@/components/CoverImage";
import { CARD_COLUMNS, CARD_GRID } from "@/lib/card-grid";
import { searchMatches } from "@/lib/search-match";

export interface SearchFilm {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  collectionName: string | null;
}
export interface SearchShow {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}
export interface SearchArtist {
  id: number;
  name: string;
  hasPhoto: boolean;
  coverAlbumId: number | null;
  coverVersion: number | null;
}
export interface SearchAlbum {
  id: number;
  title: string;
  artistName: string;
  hasCover: boolean;
  coverVersion: number | null;
}

export default function SearchResults({
  initialQuery,
  films,
  shows,
  artists,
  albums,
}: {
  initialQuery: string;
  films: SearchFilm[];
  shows: SearchShow[];
  artists: SearchArtist[];
  albums: SearchAlbum[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Straight to typing, as the app's search tab does — but not on a
    // reload with results already showing, where the keyboard would cover
    // them.
    if (!initialQuery) inputRef.current?.focus();
  }, [initialQuery]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [query]);

  const searching = query.trim().length > 0;
  const matchedFilms = searching ? films.filter((f) => searchMatches(query, f.title, f.collectionName)) : [];
  const matchedShows = searching ? shows.filter((s) => searchMatches(query, s.title)) : [];
  const matchedArtists = searching ? artists.filter((a) => searchMatches(query, a.name)) : [];
  const matchedAlbums = searching ? albums.filter((a) => searchMatches(query, a.title, a.artistName)) : [];
  const nothing =
    matchedFilms.length + matchedShows.length + matchedArtists.length + matchedAlbums.length === 0;

  return (
    <div className={`flex flex-1 flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 ${CARD_COLUMNS}`}>
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-3xl tracking-wide">Search</h1>
        <label className="flex items-center gap-2 rounded-xl border border-border bg-bg-elevated px-3 py-2.5 focus-within:border-accent-border">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-text-faint" />
          <span className="sr-only">Search the library</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Movies, shows, artists, albums"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-base text-text placeholder-text-faint focus-visible:outline-none"
          />
        </label>
      </div>

      {!searching ? (
        <p className="text-sm text-text-muted">Search across everything you can play here.</p>
      ) : nothing ? (
        <p className="text-sm text-text-muted">Nothing matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <>
          <Section title="Movies" count={matchedFilms.length}>
            {matchedFilms.map((f) => (
              <Link key={f.id} href={`/film/${f.id}`} className="flex flex-col gap-1.5">
                <PosterImage
                  posterPath={f.posterPath}
                  title={f.title}
                  year={f.year}
                  className="aspect-2/3 w-full rounded-lg border border-border"
                />
                <Caption title={f.title} detail={f.year ? String(f.year) : null} />
              </Link>
            ))}
          </Section>
          <Section title="Shows" count={matchedShows.length}>
            {matchedShows.map((s) => (
              <Link key={s.id} href={`/shows/${s.id}`} className="flex flex-col gap-1.5">
                <PosterImage
                  posterPath={s.posterPath}
                  title={s.title}
                  year={s.year}
                  className="aspect-2/3 w-full rounded-lg border border-border"
                />
                <Caption title={s.title} detail={s.year ? String(s.year) : null} />
              </Link>
            ))}
          </Section>
          <Section title="Artists" count={matchedArtists.length}>
            {matchedArtists.map((a) => (
              <Link key={a.id} href={`/music/artist/${a.id}`} className="flex flex-col gap-1.5">
                <CoverImage
                  src={a.hasPhoto ? `/api/artist-image/${a.id}/photo` : null}
                  albumId={a.coverAlbumId}
                  version={a.coverVersion}
                  title={a.name}
                  className="w-full rounded-full border border-border"
                />
                <Caption title={a.name} detail={null} centred />
              </Link>
            ))}
          </Section>
          <Section title="Albums" count={matchedAlbums.length}>
            {matchedAlbums.map((a) => (
              <Link key={a.id} href={`/music/album/${a.id}`} className="flex flex-col gap-1.5">
                <CoverImage
                  albumId={a.hasCover ? a.id : null}
                  version={a.coverVersion}
                  title={a.title}
                  className="w-full rounded-lg border border-border"
                />
                <Caption title={a.title} detail={a.artistName} />
              </Link>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl tracking-wide">{title}</h2>
      <div className={CARD_GRID}>{children}</div>
    </section>
  );
}

function Caption({ title, detail, centred = false }: { title: string; detail: string | null; centred?: boolean }) {
  return (
    <span className={`flex flex-col ${centred ? "items-center text-center" : ""}`}>
      <span className="line-clamp-2 text-sm leading-snug text-text">{title}</span>
      {detail && <span className="truncate text-xs text-text-faint">{detail}</span>}
    </span>
  );
}
