// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import AudioCodecBadge from "@/components/AudioCodecBadge";
import AlbumFormatTabs from "@/components/AlbumFormatTabs";
import DeleteAlbumButton from "@/components/DeleteAlbumButton";
import { getAlbumDetail } from "@/lib/queries-music";
import type { AlbumTrackView } from "@/lib/queries-music";
import { qualityLabel, qualityLabelVerbose } from "@/lib/audio-quality";
import { titleCase } from "@/lib/text-case";

const KIND_LABELS: Record<string, string> = {
  STUDIO: "Studio",
  COMPILATION: "Compilation",
  EP: "EP",
  LIVE: "Live",
  SINGLE: "Single",
  REMIX: "Remix",
  SOUNDTRACK: "Soundtrack",
  OTHER: "Other",
};

// Most common non-null value in a list — used for both the dominant codec
// and the dominant quality string below. Ties keep whichever value was
// encountered first.
function modal<T>(values: (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// The album's "summary" badge shown next to the title — whichever codec and
// quality string the most tracks share (independently modal, so a
// single-codec album with one outlier bitrate still gets a clean pair).
// Per-track badges only render below when a track's codec OR quality
// differs from this dominant pair (e.g. one bonus MP3 in an otherwise ALAC
// album, or one lower-bitrate rip), so the common case stays quiet.
function dominantCodec(tracks: AlbumTrackView[]): string | null {
  return modal(tracks.map((t) => t.codec));
}

function dominantQuality(tracks: AlbumTrackView[]): string | null {
  return modal(tracks.map((t) => qualityLabel(t)));
}

function dominantQualityVerbose(tracks: AlbumTrackView[]): string | null {
  return modal(tracks.map((t) => qualityLabelVerbose(t)));
}

export default async function AlbumPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const albumId = Number(id);
  if (!Number.isInteger(albumId)) notFound();

  const album = await getAlbumDetail(albumId);
  if (!album) notFound();

  const allTracks = album.discs.flatMap((d) => d.tracks);
  const codec = dominantCodec(allTracks);
  const quality = dominantQuality(allTracks);
  const qualityVerbose = dominantQualityVerbose(allTracks);
  const displayTitle = titleCase(album.title);

  // Already in disc-then-trackNumber order (getAlbumDetail's sort), flattened
  // with each track's disc number attached and DRM (.m4p — FairPlay,
  // unplayable in-browser) filtered out.
  const playableTracks = album.discs.flatMap((d) =>
    d.tracks
      .filter((t) => t.codec !== "drm")
      .map((t) => ({
        id: t.id,
        title: t.title,
        codec: t.codec,
        durationSecs: t.durationSecs,
        disc: d.disc,
        trackNumber: t.trackNumber,
      })),
  );
  const canPlay = album.owned && playableTracks.length > 0;
  const drmOnly = album.owned && allTracks.length > 0 && playableTracks.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
      <Link
        href={`/music/artist/${album.artist.id}`}
        className="w-fit text-xs font-medium text-text-muted hover:text-text"
      >
        ← {album.artist.name}
      </Link>

      <AlbumFormatTabs
        meta={
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-3xl leading-none tracking-wide text-balance sm:text-4xl">
              {displayTitle}
            </h1>
            <Link
              href={`/music/artist/${album.artist.id}`}
              className="w-fit text-sm text-text-muted hover:text-accent"
            >
              {album.artist.name}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-text-muted">{album.year ?? "Year unknown"}</span>
              <span className="rounded border border-dvd-border bg-dvd-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none text-dvd">
                {KIND_LABELS[album.kind] ?? album.kind}
              </span>
              {Array.from(new Set(album.copies.map((c) => c.medium))).map((medium) => (
                <span
                  key={medium}
                  className="rounded border border-good-border bg-good-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none text-good"
                >
                  {medium === "VINYL" ? "Vinyl" : medium}
                  {album.copies.filter((c) => c.medium === medium).length > 1
                    ? ` ×${album.copies.filter((c) => c.medium === medium).length}`
                    : ""}
                  {album.copies.some((c) => c.medium === medium && c.inferred) ? "?" : ""}
                </span>
              ))}
              {codec != null && <AudioCodecBadge codec={codec} quality={quality} />}
            </div>
            {album.copies.some((c) => c.hasCover) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {album.copies
                  .filter((c) => c.hasCover)
                  .map((copy) => (
                    // Small inline badge, not worth next/image's fill/layout machinery.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={copy.id}
                      src={`/api/physical-cover/${copy.id}`}
                      alt={`${copy.medium} cover art`}
                      className="h-8 w-8 shrink-0 rounded border border-border-strong object-cover"
                    />
                  ))}
              </div>
            )}
          </div>
        }
        albumId={album.id}
        albumTitle={displayTitle}
        albumHasCover={album.hasCover}
        coverVersion={album.coverVersion}
        artistName={album.artist.name}
        owned={album.owned}
        copies={album.copies}
        digitalSource={album.digitalSource}
        discogsUrl={album.discogsUrl}
        discs={album.discs}
        dominantCodec={codec}
        dominantQuality={quality}
        dominantQualityVerbose={qualityVerbose}
        playableTracks={playableTracks}
        canPlay={canPlay}
        drmOnly={drmOnly}
      />

      {!album.owned && (
        <DeleteAlbumButton albumId={album.id} title={album.title} artistId={album.artist.id} />
      )}
    </div>
  );
}
