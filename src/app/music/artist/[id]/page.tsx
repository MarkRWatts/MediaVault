// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import CoverImage from "@/components/CoverImage";
import { getArtistDetail } from "@/lib/queries-music";
import type { ArtistCatalogueAlbum, ArtistShelfAlbum } from "@/lib/queries-music";

const KIND_LABELS: Record<string, string> = {
  COMPILATION: "Compilation",
  EP: "EP",
  LIVE: "Live",
  SINGLE: "Single",
  REMIX: "Remix",
  SOUNDTRACK: "Soundtrack",
  OTHER: "Other",
};

const CHIP_TONE: Record<"good" | "missing" | "dvd", string> = {
  good: "border-good-border bg-good-bg text-good",
  missing: "border-missing-border bg-missing-bg text-missing",
  dvd: "border-dvd-border bg-dvd-bg text-dvd",
};

function Chip({ tone, children }: { tone: keyof typeof CHIP_TONE; children: React.ReactNode }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

// Studio back-catalogue tile: cover, Owned/Missing chip, title, year. Missing
// entries are non-links (nothing to view — no local files, no album page)
// and get the same grayscale/dashed treatment as owned=false films.
function StudioAlbumCard({ album }: { album: ArtistCatalogueAlbum }) {
  const body = (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border ${
        album.owned
          ? "border-border bg-bg-elevated"
          : "border-dashed border-border/60 bg-bg-elevated/40"
      }`}
    >
      <CoverImage
        albumId={album.hasCover ? album.id : null}
        version={album.coverVersion}
        title={album.title}
        className={album.owned ? "w-full" : "w-full grayscale opacity-45"}
      />
      <div className="flex flex-col gap-0.5 p-2.5">
        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-text">{album.title}</h3>
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-text-faint">{album.year ?? "—"}</span>
          <Chip tone={album.owned ? "good" : "missing"}>{album.owned ? "Owned" : "Missing"}</Chip>
        </span>
      </div>
    </div>
  );

  return album.owned ? (
    <Link href={`/music/album/${album.id}`} className="hover-lift block">
      {body}
    </Link>
  ) : (
    <div aria-label={`${album.title} — not owned`}>{body}</div>
  );
}

// "Also on the shelf" tile — owned non-studio albums, always a link (they're
// on disk), kind chip instead of Owned/Missing.
function ShelfAlbumCard({ album }: { album: ArtistShelfAlbum }) {
  return (
    <Link
      href={`/music/album/${album.id}`}
      className="hover-lift block overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <CoverImage albumId={album.hasCover ? album.id : null} version={album.coverVersion} title={album.title} className="w-full" />
      <div className="flex flex-col gap-0.5 p-2">
        <h3 className="line-clamp-2 text-xs text-text-muted">{album.title}</h3>
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-text-faint">{album.year ?? "—"}</span>
          <Chip tone="dvd">{KIND_LABELS[album.kind] ?? album.kind}</Chip>
        </span>
      </div>
    </Link>
  );
}

// Plain tile for the various-artist (Compilations) grid — every entry is
// owned by construction, so no Owned/Missing chip is needed.
function PlainAlbumCard({ album }: { album: ArtistCatalogueAlbum }) {
  return (
    <Link
      href={`/music/album/${album.id}`}
      className="hover-lift block overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <CoverImage albumId={album.hasCover ? album.id : null} version={album.coverVersion} title={album.title} className="w-full" />
      <div className="flex flex-col gap-0.5 p-2.5">
        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-text">{album.title}</h3>
        <span className="font-mono text-[11px] text-text-faint">{album.year ?? "—"}</span>
      </div>
    </Link>
  );
}

function decadeLabel(year: number | null): string {
  if (year == null) return "UNDATED"; // pre-styled caps: the label span no longer uppercases (see below)
  return `${Math.floor(year / 10) * 10}s`;
}

// studio is pre-sorted ascending by year (nulls last) by getArtistDetail, so
// a simple consecutive-run grouping is enough — no need to bucket by a map.
function groupByDecade(items: ArtistCatalogueAlbum[]): { label: string; items: ArtistCatalogueAlbum[] }[] {
  const groups: { label: string; items: ArtistCatalogueAlbum[] }[] = [];
  for (const item of items) {
    const label = decadeLabel(item.year);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

const ALBUM_GRID = "grid grid-cols-[repeat(auto-fill,minmax(8.6rem,1fr))] gap-3";

export default async function ArtistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const artistId = Number(id);
  if (!Number.isInteger(artistId)) notFound();

  const detail = await getArtistDetail(artistId);
  if (!detail) notFound();

  const { artist, studio, shelf, stats } = detail;
  const missing = stats.total - stats.owned;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4">
        <Link href="/music" className="w-fit text-xs font-medium text-text-muted hover:text-text">
          ← Music
        </Link>
        <div>
          <h1 className="font-display text-4xl leading-none tracking-wide text-balance sm:text-5xl">
            {artist.name}
          </h1>
          {artist.disambiguation && (
            <p className="mt-1 text-sm text-text-faint">{artist.disambiguation}</p>
          )}
        </div>

        {!artist.various && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-3 sm:max-w-md">
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3">
                <span className="font-display text-2xl leading-none text-text">
                  {stats.owned}/{stats.total}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-text-faint">Owned</span>
              </div>
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3">
                <span
                  className={`font-display text-2xl leading-none ${
                    missing > 0 ? "text-missing" : "text-text"
                  }`}
                >
                  {missing}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-text-faint">Missing</span>
              </div>
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3">
                <span className="font-display text-2xl leading-none text-text">{stats.pct}%</span>
                <span className="text-[10px] uppercase tracking-widest text-text-faint">Complete</span>
              </div>
            </div>
            <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-bg-elevated-2">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-accent-bright"
                style={{ width: `${stats.pct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {artist.various ? (
        <section className="flex flex-col gap-3">
          {studio.length === 0 && shelf.length === 0 ? (
            <p className="py-16 text-center text-sm text-text-faint">No albums yet.</p>
          ) : (
            <div className={ALBUM_GRID}>
              {[...studio, ...shelf]
                .filter((a) => a.owned)
                .slice()
                .sort((a, b) => {
                  if (a.year === null && b.year === null) return 0;
                  if (a.year === null) return 1;
                  if (b.year === null) return -1;
                  return a.year - b.year;
                })
                .map((a) => (
                  <PlainAlbumCard key={a.id} album={a} />
                ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-6">
            {studio.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-faint">
                No studio catalogue found for this artist yet.
              </p>
            ) : (
              groupByDecade(studio).map((group) => (
                <div key={group.label} className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    {/* No `uppercase` here — it would render "1990s" as "1990S". */}
                    <span className="shrink-0 font-mono text-xs tracking-widest text-text-faint">
                      {group.label}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  <div className={ALBUM_GRID}>
                    {group.items.map((a) => (
                      <StudioAlbumCard key={a.id} album={a} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>

          {shelf.length > 0 && (
            <section className="flex flex-col gap-3 border-t border-border pt-6">
              <h2 className="font-display text-xl tracking-wide">Also on the shelf</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2.5">
                {shelf.map((a) => (
                  <ShelfAlbumCard key={a.id} album={a} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
