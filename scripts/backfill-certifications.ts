// One-off backfill for Film.certification / Show.certification (UK
// certificates from TMDB, added 2026-09-05): every matched film and show
// gets one TMDB call. Idempotent; safe to re-run. Enrich only revisits
// unmatched/low-confidence rows, hence this script.
//
//   npx tsx scripts/backfill-certifications.ts
//   docker compose exec app npx tsx scripts/backfill-certifications.ts

import "dotenv/config";
import { prisma } from "@/lib/db";
import { tmdbFetch, ukCertification, ukTvRating } from "@/lib/tmdb";

const tmdb = (pathname: string, append: string): Promise<unknown> => tmdbFetch(pathname, { append_to_response: append });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const films = await prisma.film.findMany({ where: { tmdbId: { not: null } }, select: { id: true, title: true, tmdbId: true, certification: true }, orderBy: { id: "asc" } });
  console.log(`${films.length} matched film(s)`);
  let filmSet = 0;
  for (const f of films) {
    try {
      const cert = ukCertification(await tmdb(`/movie/${f.tmdbId}`, "release_dates"));
      if (cert !== f.certification) {
        await prisma.film.update({ where: { id: f.id }, data: { certification: cert } });
        filmSet++;
        console.log(`  ${f.title}: ${cert ?? "(none)"}`);
      }
    } catch (err) {
      console.log(`  ! ${f.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await pause(120);
  }
  const shows = await prisma.show.findMany({ where: { tmdbId: { not: null } }, select: { id: true, title: true, tmdbId: true, certification: true }, orderBy: { id: "asc" } });
  console.log(`${shows.length} matched show(s)`);
  let showSet = 0;
  for (const s of shows) {
    try {
      const cert = ukTvRating(await tmdb(`/tv/${s.tmdbId}`, "content_ratings"));
      if (cert !== s.certification) {
        await prisma.show.update({ where: { id: s.id }, data: { certification: cert } });
        showSet++;
        console.log(`  ${s.title}: ${cert ?? "(none)"}`);
      }
    } catch (err) {
      console.log(`  ! ${s.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await pause(120);
  }
  console.log(`updated ${filmSet} film(s), ${showSet} show(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
