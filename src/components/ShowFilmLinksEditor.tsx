"use client";

import { useActionState, useState } from "react";
import {
  linkFilmToShow,
  unlinkFilmFromShow,
  type FilmShowLinkState,
} from "@/app/actions/film-shows";
import type { LinkableFilm } from "@/lib/queries-film-shows";

/** How many matches the picker lists at once — enough to find a film by a
 *  word or two of its title without the list running off the screen. */
const MAX_MATCHES = 8;

/** The app owner's control for saying which films belong with a show —
 *  Serenity with Firefly, the 1994 Stargate with all three SG series. There
 *  is nothing to derive this from (TMDB has no movie-to-show relation), so
 *  it is typed in by hand. It lives on the show page, under the Films
 *  shelf: FILM_PAGE_PLAN.md took owner tools off the film page, and a show
 *  is where the handful of films that need it are looked for.
 *
 *  Only rendered for the owner, which is cosmetic; both actions call
 *  requireOwner() themselves. Collapsed to a single button until used, so
 *  the page doesn't grow a form nobody asked for. */
export default function ShowFilmLinksEditor({
  showId,
  linked,
  allFilms,
}: {
  showId: number;
  /** The films already linked, as the Films shelf shows them. */
  linked: LinkableFilm[];
  /** Every film that can be linked — the pool to search. */
  allFilms: LinkableFilm[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [linkState, linkAction, linking] = useActionState<FilmShowLinkState, FormData>(
    linkFilmToShow,
    null,
  );
  const [unlinkState, unlinkAction, unlinking] = useActionState<FilmShowLinkState, FormData>(
    unlinkFilmFromShow,
    null,
  );

  const linkedIds = new Set(linked.map((f) => f.id));
  const wanted = query.trim().toLowerCase();
  const matches = wanted
    ? allFilms.filter((f) => !linkedIds.has(f.id) && f.title.toLowerCase().includes(wanted)).slice(0, MAX_MATCHES)
    : [];
  const error = linkState?.error ?? unlinkState?.error;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-fit rounded-full border border-border px-3 py-1 text-xs text-text-faint transition-colors hover:border-accent hover:text-accent"
      >
        {linked.length > 0 ? "Edit linked films" : "Link to a film"}
      </button>
    );
  }

  return (
    <div className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-3">
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {linked.map((f) => (
            <form key={f.id} action={unlinkAction}>
              <input type="hidden" name="filmId" value={f.id} />
              <input type="hidden" name="showId" value={showId} />
              <button
                type="submit"
                disabled={unlinking}
                aria-label={`Unlink ${f.title}`}
                className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted transition-colors hover:border-missing-border hover:text-missing disabled:cursor-not-allowed disabled:opacity-40"
              >
                {f.title} ×
              </button>
            </form>
          ))}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-faint">Link this show to a film</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search films…"
          autoFocus
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder-text-faint focus-visible:outline-none"
        />
      </label>

      {wanted && matches.length === 0 && <p className="text-xs text-text-faint">No film matches that.</p>}
      {matches.length > 0 && (
        <ul className="flex flex-col">
          {matches.map((f) => (
            <li key={f.id}>
              <form action={linkAction} className="flex items-center justify-between gap-2 py-1">
                <input type="hidden" name="filmId" value={f.id} />
                <input type="hidden" name="showId" value={showId} />
                <span className="min-w-0 truncate text-sm text-text">
                  {f.title}
                  {f.year ? <span className="text-text-faint"> ({f.year})</span> : null}
                </span>
                <button
                  type="submit"
                  disabled={linking}
                  className="shrink-0 rounded border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Link
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-missing">{error}</p>}

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-fit text-xs font-medium text-text-muted transition-colors hover:text-text"
      >
        Done
      </button>
    </div>
  );
}
