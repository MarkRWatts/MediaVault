// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import { getReportData, getTvReportData } from "@/lib/queries";
import type { IssueFilm } from "@/lib/queries";

function issueTags(f: IssueFilm): string[] {
  const tags: string[] = [];
  if (f.matchConfidence === "LOW") tags.push("Low-confidence match");
  if (f.matchConfidence === "UNMATCHED") tags.push("Unmatched");
  if (f.hasUnknownFormatVersion) tags.push("Unknown format");
  if (f.missingYear) tags.push("No year");
  return tags;
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-text-faint">{children}</p>;
}

export default async function ReportPage() {
  const [{ totals, missingByCollection, upgradeCandidates, issues }, tv] = await Promise.all([
    getReportData(),
    getTvReportData(),
  ]);

  const tiles: { label: string; value: number | string; tone?: "accent" | "missing" }[] = [
    { label: "Films owned", value: totals.filmsOwned },
    { label: "Discs", value: totals.discs },
    { label: "4K", value: totals.uhdFilmCount },
    { label: "Blu-ray", value: totals.blurayCount },
    { label: "DVD", value: totals.dvdCount },
    { label: "Collections complete", value: totals.collectionsComplete },
    { label: "Collections incomplete", value: totals.collectionsIncomplete, tone: "accent" },
    { label: "Missing films", value: totals.missingCount, tone: "missing" },
    { label: "Shows", value: `${tv.showsComplete}/${tv.showsTotal}` },
    { label: "Episodes", value: `${tv.episodesOwned}/${tv.episodesTotal}` },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-6 sm:px-6">
      <div>
        <h1 className="font-display text-3xl tracking-wide">Report</h1>
        <p className="mt-1 pb-6 text-sm text-text-faint">
          The state of the collection — gaps, upgrade candidates, and metadata that
          needs attention.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3.5"
            >
              <span
                className={`font-display text-3xl leading-none ${
                  t.tone === "accent"
                    ? "text-accent"
                    : t.tone === "missing" && typeof t.value === "number" && t.value > 0
                      ? "text-missing"
                      : "text-text"
                }`}
              >
                {t.value}
              </span>
              <span className="text-[10px] uppercase leading-tight tracking-widest text-text-faint">
                {t.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide">Missing from collections</h2>
        {missingByCollection.length === 0 ? (
          <SectionEmpty>Every known collection is fully catalogued.</SectionEmpty>
        ) : (
          <div className="flex flex-col gap-6">
            {missingByCollection.map((group) => (
              <div key={group.collectionId} className="flex flex-col gap-2.5">
                <Link
                  href={`/collections/${group.collectionId}`}
                  className="w-fit text-sm font-semibold text-text hover:text-accent"
                >
                  {group.collectionName}
                  <span className="ml-2 font-mono text-xs font-normal text-text-faint">
                    {group.films.length} missing
                  </span>
                </Link>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                  {group.films.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-bg-elevated/50 p-2"
                    >
                      <PosterImage
                        posterPath={f.posterPath}
                        title={f.title}
                        year={f.year}
                        sizes="40px"
                        className="aspect-2/3 w-10 shrink-0 rounded grayscale opacity-60"
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs text-text-muted">{f.title}</span>
                        <span className="font-mono text-[10px] text-text-faint">
                          {f.year ?? "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide">Blu-ray upgrade candidates</h2>
        <p className="-mt-2 text-xs text-text-faint">
          Owned only on DVD — no Blu-ray version on disk.
        </p>
        {upgradeCandidates.length === 0 ? (
          <SectionEmpty>No DVD-only films — the library is fully upgraded.</SectionEmpty>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {upgradeCandidates.map((f) => (
              <Link
                key={f.id}
                href={`/film/${f.id}`}
                className="hover-lift flex items-center gap-2.5 rounded-lg border border-border bg-bg-elevated p-2"
              >
                <PosterImage
                  posterPath={f.posterPath}
                  title={f.title}
                  year={f.year}
                  sizes="40px"
                  className="aspect-2/3 w-10 shrink-0 rounded"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-xs text-text">{f.title}</span>
                  <div className="flex flex-wrap gap-1">
                    {f.formats.map((fmt) => (
                      <FormatBadge key={fmt} kind={fmt} />
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4 pb-16">
        <h2 className="font-display text-xl tracking-wide">Library issues</h2>
        <p className="-mt-2 text-xs text-text-faint">
          Films that could use another look — a low-confidence or missing metadata
          match, an unrecognised disc format, or no release year.
        </p>
        {issues.length === 0 ? (
          <SectionEmpty>No outstanding issues.</SectionEmpty>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
            {issues.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <Link
                  href={`/film/${f.id}`}
                  className="text-sm text-text hover:text-accent"
                >
                  {f.title}
                  {f.year && (
                    <span className="ml-2 font-mono text-xs text-text-faint">{f.year}</span>
                  )}
                </Link>
                <div className="flex flex-wrap gap-1.5">
                  {issueTags(f).map((tag) => (
                    <span
                      key={tag}
                      className="rounded border border-accent-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-accent"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4 pb-16">
        <h2 className="font-display text-xl tracking-wide">Missing from shows</h2>
        {tv.missingByShow.length === 0 ? (
          <SectionEmpty>Every known show is fully catalogued.</SectionEmpty>
        ) : (
          <div className="flex flex-col gap-3">
            {tv.missingByShow.map((group) => (
              <div
                key={group.showId}
                className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-3.5"
              >
                <Link
                  href={`/shows/${group.showId}`}
                  className="flex items-center gap-3 text-sm font-semibold text-text hover:text-accent"
                >
                  <PosterImage
                    posterPath={group.posterPath}
                    title={group.showTitle}
                    sizes="32px"
                    className="aspect-2/3 w-8 shrink-0 rounded"
                  />
                  <span className="min-w-0 truncate">{group.showTitle}</span>
                </Link>
                <ul className="flex flex-col gap-1 pl-11">
                  {group.lines.map((line) => (
                    <li key={line.key} className="font-mono text-xs text-text-muted">
                      {line.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
