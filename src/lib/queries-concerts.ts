// Data access for the Music page's Concerts shelf. Server-only, same style
// as queries.ts — which is where the mirror-image query lives: everything
// Movies-side filters kind=CONCERT out, this is the one query that asks for
// them. The cards link to /film/[id]: a concert is a Film row and its detail
// page, playback and progress are the film ones unchanged.

import { prisma } from "@/lib/db";
import { allowsCertificate, type AgeLimit } from "@/lib/age-rating";
import { type Format } from "@/lib/constants";

export interface ConcertCard {
  id: number;
  title: string;
  performer: string | null;
  year: number | null;
  posterPath: string | null;
  certification: string | null;
  formats: Format[];
}

/** Concerts on disk, by act then title — the act is the thing you browse by,
 *  so "Pink Floyd" sorts its shows together rather than scattering them
 *  through one alphabetical run of titles. Acts before the actless. */
export async function getConcerts(limit: AgeLimit): Promise<ConcertCard[]> {
  const concerts = await prisma.film.findMany({
    where: { kind: "CONCERT", owned: true },
    orderBy: { sortTitle: "asc" },
    select: {
      id: true,
      title: true,
      performer: true,
      year: true,
      posterPath: true,
      certification: true,
      versions: { select: { format: true } },
    },
  });

  return concerts
    .filter((c) => allowsCertificate(limit, c.certification))
    // Grouping by act is done here rather than in the query: SQLite sorts
    // NULL first, which would open the shelf with the nameless ones.
    .sort((a, b) => {
      if (a.performer === b.performer) return 0;
      if (a.performer === null) return 1;
      if (b.performer === null) return -1;
      return a.performer.localeCompare(b.performer);
    })
    .map((c) => ({
      id: c.id,
      title: c.title,
      performer: c.performer,
      year: c.year,
      posterPath: c.posterPath,
      certification: c.certification,
      formats: Array.from(new Set(c.versions.map((v) => v.format as Format))),
    }));
}
