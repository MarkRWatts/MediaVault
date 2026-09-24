// Data access for the hand-curated film-to-show links (FilmShowLink in
// schema.prisma): the Films shelf on a show's page, the shows a film is part
// of, and the list the owner's "Link to a film" picker (on the show page)
// chooses from. Server-only,
// same style as queries-concerts.ts.
//
// Nothing here changes what the Movies listings return — a film linked to a
// show is still an ordinary film in getLibraryFilms. This is extra surfacing,
// not a move.

import { prisma } from "@/lib/db";
import { allowsCertificate, type AgeLimit } from "@/lib/age-rating";
import { FILM_CARD_SELECT, shapeLibraryFilm, type LibraryFilm } from "@/lib/queries";

export interface LinkedShow {
  id: number;
  title: string;
  year: number | null;
}

/** The films linked to a show, oldest first — the order you'd watch them in
 *  relative to the series (Stargate 1994 before Continuum). Films with no
 *  year go last rather than leading the shelf, since SQLite sorts NULL
 *  first; ties fall back to sortTitle so the order is stable.
 *
 *  Only owned kind=FILM rows: a not-owned row exists solely to be reported
 *  as missing, and concerts are never linkable (the picker leaves them out,
 *  but this is the boundary). Age-filtered exactly as getConcerts is —
 *  a restricted viewer must not be shown a poster for something
 *  /film/[id] would 404 on. */
export async function getShowFilms(showId: number, limit: AgeLimit): Promise<LibraryFilm[]> {
  const links = await prisma.filmShowLink.findMany({
    where: { showId, film: { kind: "FILM", owned: true } },
    select: { film: { select: FILM_CARD_SELECT } },
  });

  return links
    .map((l) => l.film)
    .filter((f) => allowsCertificate(limit, f.certification))
    .map(shapeLibraryFilm)
    .sort((a, b) => {
      if (a.year === b.year) return a.sortTitle.localeCompare(b.sortTitle);
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return a.year - b.year;
    });
}

/** The shows a film is linked to. (The film page no longer shows them —
 *  FILM_PAGE_PLAN.md — but the link is two-way data.) Age-filtered
 *  for the same reason getShowFilms is: a chip a viewer can't follow is
 *  worse than no chip. */
export async function getFilmShows(filmId: number, limit: AgeLimit): Promise<LinkedShow[]> {
  const links = await prisma.filmShowLink.findMany({
    where: { filmId },
    orderBy: { show: { sortTitle: "asc" } },
    select: { show: { select: { id: true, title: true, year: true, certification: true } } },
  });

  return links
    .map((l) => l.show)
    .filter((s) => allowsCertificate(limit, s.certification))
    .map((s) => ({ id: s.id, title: s.title, year: s.year }));
}

/** A film as the show page's "Link to a film" picker lists it. */
export interface LinkableFilm {
  id: number;
  title: string;
  year: number | null;
}

/** Every film the owner may link to a show, alphabetically: owned, and never
 *  a concert (linkFilmToShow refuses those anyway) — the same set
 *  getShowFilms will actually shelve, so a link made here always shows up.
 *  Age-filtered too: the app owner is normally unrestricted, but nothing
 *  guarantees it. */
export async function getLinkableFilms(limit: AgeLimit): Promise<LinkableFilm[]> {
  const films = await prisma.film.findMany({
    where: { kind: "FILM", owned: true },
    orderBy: { sortTitle: "asc" },
    select: { id: true, title: true, year: true, certification: true },
  });

  return films
    .filter((f) => allowsCertificate(limit, f.certification))
    .map((f) => ({ id: f.id, title: f.title, year: f.year }));
}
