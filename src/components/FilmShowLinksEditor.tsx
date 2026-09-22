"use client";

import { useActionState, useState } from "react";
import {
  linkFilmToShow,
  unlinkFilmFromShow,
  type FilmShowLinkState,
} from "@/app/actions/film-shows";
import type { LinkedShow } from "@/lib/queries-film-shows";

/** The app owner's control for saying which shows a film belongs with —
 *  Serenity with Firefly, the 1994 Stargate with all three SG series. There
 *  is nothing to derive this from (TMDB has no movie-to-show relation), so
 *  it is typed in by hand here and nowhere else.
 *
 *  Only rendered for the owner, which is cosmetic; both actions call
 *  requireOwner() themselves. Collapsed to a single button until used, so
 *  the film page doesn't grow a form nobody asked for. */
export default function FilmShowLinksEditor({
  filmId,
  linked,
  allShows,
}: {
  filmId: number;
  /** The shows already linked, as the chips above show them. */
  linked: LinkedShow[];
  /** Every show in the library — the pool to pick from. */
  allShows: LinkedShow[];
}) {
  const [open, setOpen] = useState(false);
  const [linkState, linkAction, linking] = useActionState<FilmShowLinkState, FormData>(
    linkFilmToShow,
    null,
  );
  const [unlinkState, unlinkAction, unlinking] = useActionState<FilmShowLinkState, FormData>(
    unlinkFilmFromShow,
    null,
  );

  const linkedIds = new Set(linked.map((s) => s.id));
  const available = allShows.filter((s) => !linkedIds.has(s.id));
  const error = linkState?.error ?? unlinkState?.error;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-faint transition-colors hover:border-accent hover:text-accent"
      >
        {linked.length > 0 ? "Edit shows" : "Link a show"}
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-3">
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {linked.map((s) => (
            <form key={s.id} action={unlinkAction}>
              <input type="hidden" name="filmId" value={filmId} />
              <input type="hidden" name="showId" value={s.id} />
              <button
                type="submit"
                disabled={unlinking}
                aria-label={`Unlink ${s.title}`}
                className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted transition-colors hover:border-missing-border hover:text-missing disabled:cursor-not-allowed disabled:opacity-40"
              >
                {s.title} ×
              </button>
            </form>
          ))}
        </div>
      )}

      {available.length === 0 ? (
        <p className="text-xs text-text-faint">
          {allShows.length === 0
            ? "No shows in the library yet."
            : "Every show is already linked to this film."}
        </p>
      ) : (
        <form action={linkAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="filmId" value={filmId} />
          <label className="sr-only" htmlFor={`film-show-${filmId}`}>
            Link this film to a show
          </label>
          <select
            id={`film-show-${filmId}`}
            name="showId"
            defaultValue=""
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text focus-visible:outline-none"
          >
            <option value="" disabled>
              Choose a show…
            </option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
                {s.year ? ` (${s.year})` : ""}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={linking}
            className="rounded border border-accent px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Link
          </button>
        </form>
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
