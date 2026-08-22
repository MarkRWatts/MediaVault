// Physical-formats report: what the collection looks like as shelves of
// actual media — the vinyl crate, CD counts, and the digital albums whose
// source can't be assumed (non-ALAC → iTunes purchase or download until
// tagged by hand on the album page).

// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import CoverImage from "@/components/CoverImage";
import { getFormatsReport } from "@/lib/queries-music";

export default async function MusicFormatsPage() {
  const { totals, vinylByFormat, crate, unconfirmed } = await getFormatsReport();

  const tiles: { label: string; value: number }[] = [
    { label: "On CD", value: totals.cdAlbums },
    { label: "On vinyl", value: totals.vinylAlbums },
    { label: "Both formats", value: totals.bothFormats },
    { label: "Digital only", value: totals.digitalOnly },
    { label: "Vinyl discs", value: totals.vinylDiscs },
  ];

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <Link href="/music" className="text-xs font-medium text-text-muted hover:text-text">
          ← Music
        </Link>
        <h1 className="mt-2 font-display text-3xl tracking-wide">Formats</h1>
        <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
          Physical media across the collection — CDs, the vinyl crate, and unconfirmed sources
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3.5"
            >
              <span className="font-display text-3xl leading-none text-text">{t.value}</span>
              <span className="text-[10px] uppercase leading-tight tracking-widest text-text-faint">
                {t.label}
              </span>
            </div>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-xl tracking-wide">Vinyl crate</h2>
            {vinylByFormat.length > 0 && (
              <span className="font-mono text-xs text-text-faint">
                {vinylByFormat.map((f) => `${f.count}× ${f.format}`).join(" · ")}
              </span>
            )}
          </div>
          {crate.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-faint">
              No vinyl yet — tag an album on its page, or add a vinyl-only album from the Music
              index.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {crate.map((a) => (
                <Link
                  key={a.id}
                  href={`/music/album/${a.id}`}
                  className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
                >
                  <CoverImage
                    albumId={a.hasCover ? a.id : null}
                    version={a.coverVersion}
                    title={a.title}
                    className="w-full border-b border-border"
                  />
                  <div className="flex flex-1 flex-col gap-0.5 p-2.5">
                    <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-text">
                      {a.title}
                    </h3>
                    <span className="text-[11px] text-text-muted">{a.artistName}</span>
                    <span className="mt-auto pt-1 font-mono text-[11px] text-text-faint">
                      {[
                        a.format,
                        a.pressYear ?? a.year,
                        a.catalogNo,
                        !a.digitallyOwned && "no rip",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {unconfirmed.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl tracking-wide">Unconfirmed sources</h2>
            <p className="max-w-2xl text-xs text-text-faint">
              Digital albums with non-ALAC tracks — an iTunes purchase or a download rather than a
              CD rip, until you say otherwise. Tag the ones you own physically from their album
              pages.
            </p>
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-elevated">
              {unconfirmed.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/music/album/${a.id}`}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-bg"
                  >
                    <span className="min-w-0 truncate text-sm text-text">
                      {a.artistName} — {a.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] uppercase text-text-faint">
                      {a.codecs.join(", ")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
