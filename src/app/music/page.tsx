// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import CoverImage from "@/components/CoverImage";
import VinylAddForm from "@/components/VinylAddForm";
import { getMusicIndex, getArtistDetail } from "@/lib/queries-music";

export default async function MusicPage() {
  const { totals, artists } = await getMusicIndex();

  // The Compilations pseudo-artist (various=true) skips MusicBrainz matching
  // entirely, so its studio counters are always 0/0 — getMusicIndex has no
  // "total albums" field to fall back on, so pull its own detail (studio +
  // shelf) for a plain album count instead of a misleading "0/0" fraction.
  const variousArtist = artists.find((a) => a.various) ?? null;
  const variousAlbumCount = variousArtist
    ? await getArtistDetail(variousArtist.id).then((d) => (d ? d.studio.length + d.shelf.length : 0))
    : 0;

  const tiles: { label: string; value: number | string }[] = [
    { label: "Artists", value: totals.artists },
    { label: "Albums owned", value: totals.albumsOwned },
    { label: "Tracks", value: totals.tracks },
    { label: "Lossless", value: `${totals.losslessPct}%` },
    { label: "On vinyl", value: totals.vinylOwned },
  ];

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Music</h1>
        {artists.length > 0 && (
          <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
            {totals.artists} artist{totals.artists === 1 ? "" : "s"} · {totals.albumsOwned} album
            {totals.albumsOwned === 1 ? "" : "s"} · {totals.tracks} track
            {totals.tracks === 1 ? "" : "s"}
          </p>
        )}
        {artists.length === 0 && <div className="pb-6" />}
      </div>

      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
        {artists.length > 0 && (
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
        )}

        {/* Vinyl-only albums have nothing to do with the scanned digital
            library, so this stays reachable even before a scan has ever
            run — an empty artist list must not hide it. */}
        <VinylAddForm />

        {artists.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
            <p className="font-display text-2xl tracking-wide text-text-muted">
              No music yet — run a scan
            </p>
            <p className="max-w-sm text-sm text-text-faint">
              Artists appear here once MUSIC_PATH has been scanned and matched.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {artists.map((a) => (
              <Link
                key={a.id}
                href={`/music/artist/${a.id}`}
                className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
              >
                <CoverImage
                  albumId={a.coverAlbumId}
                  version={a.coverVersion}
                  title={a.name}
                  className="w-full border-b border-border"
                />
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">
                    {a.name}
                  </h3>
                  <span className="mt-auto font-mono text-xs text-text-faint">
                    {a.various
                      ? `${variousAlbumCount} album${variousAlbumCount === 1 ? "" : "s"}`
                      : `${a.ownedStudio}/${a.totalStudio}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
