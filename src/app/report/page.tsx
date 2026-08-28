// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import CoverImage from "@/components/CoverImage";
import { getReportData, getTvReportData } from "@/lib/queries";
import type { IssueFilm, FormatStat } from "@/lib/queries";
import { getMusicReportData } from "@/lib/queries-music";
import { requireOwnerOrRedirect } from "@/lib/require-member";

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

// Small horizontal bar list — count per codec/format, widest bar first.
function FormatBreakdown({ title, rows }: { title: string; rows: FormatStat[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <h3 className="mb-2 text-[10px] uppercase tracking-widest text-text-faint">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-faint">No data.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2.5">
              <span className="w-28 shrink-0 truncate font-mono text-xs text-text-muted">
                {r.label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-hover">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
              <span className="w-8 shrink-0 text-right font-mono text-xs text-text-faint">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Native <details> keeps the page server-rendered with zero client JS; the
// long lists default to collapsed so the totals strip stays in view.
function CollapsibleSection({
  title,
  subtitle,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  count: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer select-none list-none items-baseline gap-3 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className="h-3 w-3 shrink-0 self-center fill-text-faint transition-transform group-open:rotate-90"
        >
          <path d="M4 2l5 4-5 4z" />
        </svg>
        <h2 className="font-display text-xl tracking-wide group-hover:text-accent">{title}</h2>
        <span className="font-mono text-xs text-text-faint">{count}</span>
      </summary>
      {subtitle && <p className="mt-1 pl-6 text-xs text-text-faint">{subtitle}</p>}
      <div className="pt-4">{children}</div>
    </details>
  );
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  // Collection bookkeeping for the app owner, not something household
  // members need (HOUSEHOLDS_PLAN.md "Auth & gating") — bounce non-owners
  // home rather than showing a blank/error page.
  await requireOwnerOrRedirect();

  const [{ totals, missingByCollection, upgradeCandidates, issues, formatStats }, tv, music, params] = await Promise.all([
    getReportData(),
    getTvReportData(),
    getMusicReportData(),
    searchParams,
  ]);
  // Deep-linkable expansion: /report?open=collections|upgrades|issues|shows|music
  // (comma-separable). Sections default collapsed otherwise.
  const open = new Set((params.open ?? "").split(",").filter(Boolean));

  // missingByArtist only lists artists past the gap-tracking threshold (see
  // constants.ts MUSIC_GAP_MIN_OWNED/MUSIC_GAP_MIN_PCT — enforced at
  // placeholder-creation time in musicbrainz.ts, this is just a
  // belt-and-braces re-check) — the section count reflects what's actually
  // listed, not the global albumsMissing total.
  const missingBackCatalogueCount = music.missingByArtist.reduce((sum, g) => sum + g.albums.length, 0);

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
    { label: "Artists", value: music.totals.artists },
    {
      label: "Albums",
      value: `${music.totals.albumsOwned}/${music.totals.albumsOwned + music.totals.albumsMissing}`,
    },
    { label: "Lossless", value: `${music.totals.losslessPct}%` },
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

      <CollapsibleSection
        title="Missing from collections"
        defaultOpen={open.has("collections")}
        count={`${totals.missingCount} film${totals.missingCount === 1 ? "" : "s"} across ${missingByCollection.length} collection${missingByCollection.length === 1 ? "" : "s"}`}
      >
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
      </CollapsibleSection>

      <CollapsibleSection
        title="Blu-ray upgrade candidates"
        defaultOpen={open.has("upgrades")}
        subtitle="Owned only on DVD — no Blu-ray version on disk."
        count={`${upgradeCandidates.length} film${upgradeCandidates.length === 1 ? "" : "s"}`}
      >
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
      </CollapsibleSection>

      <CollapsibleSection
        title="Movie issues"
        defaultOpen={open.has("issues")}
        subtitle="Films that could use another look — a low-confidence or missing metadata match, an unrecognised disc format, or no release year."
        count={`${issues.length} film${issues.length === 1 ? "" : "s"}`}
      >
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
      </CollapsibleSection>

      <CollapsibleSection
        title="Audio & video formats"
        defaultOpen={open.has("formats")}
        subtitle="Codecs across every owned disc and audio track — the same breakdown the Movies page filters on."
        count={`${totals.discs} disc${totals.discs === 1 ? "" : "s"}`}
      >
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <FormatBreakdown title="Video codec" rows={formatStats.video} />
          <FormatBreakdown title="Audio format" rows={formatStats.audio} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Missing from shows"
        defaultOpen={open.has("shows")}
        count={`${tv.episodesTotal - tv.episodesOwned} episode${tv.episodesTotal - tv.episodesOwned === 1 ? "" : "s"} across ${tv.missingByShow.length} show${tv.missingByShow.length === 1 ? "" : "s"}`}
      >
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
      </CollapsibleSection>

      <CollapsibleSection
        title="Missing from back catalogues"
        defaultOpen={open.has("music")}
        subtitle="Studio albums an artist has enough of on disk to be worth completing — see the artist page for the full catalogue regardless of this threshold."
        count={`${missingBackCatalogueCount} album${missingBackCatalogueCount === 1 ? "" : "s"} across ${music.missingByArtist.length} artist${music.missingByArtist.length === 1 ? "" : "s"}`}
      >
        {music.missingByArtist.length === 0 ? (
          <SectionEmpty>Every qualifying artist&rsquo;s studio catalogue is fully owned.</SectionEmpty>
        ) : (
          <div className="flex flex-col gap-6">
            {music.missingByArtist.map((group) => (
              <div key={group.artistId} className="flex flex-col gap-2.5">
                <Link
                  href={`/music/artist/${group.artistId}`}
                  className="w-fit text-sm font-semibold text-text hover:text-accent"
                >
                  {group.artistName}
                  <span className="ml-2 font-mono text-xs font-normal text-text-faint">
                    {group.albums.length} missing
                  </span>
                </Link>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                  {group.albums.map((al) => (
                    <div
                      key={al.id}
                      className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-bg-elevated/50 p-2"
                    >
                      <CoverImage
                        albumId={al.hasCover ? al.id : null}
                        version={al.coverVersion}
                        title={al.title}
                        sizes="40px"
                        className="w-10 shrink-0 rounded grayscale opacity-60"
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs text-text-muted">{al.title}</span>
                        <span className="font-mono text-[10px] text-text-faint">
                          {al.year ?? "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
      <div className="pb-10" />
    </div>
  );
}
