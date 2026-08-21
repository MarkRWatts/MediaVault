// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import CoverImage from "@/components/CoverImage";
import AudioCodecBadge from "@/components/AudioCodecBadge";
import AlbumPlayer from "@/components/AlbumPlayer";
import { getAlbumDetail } from "@/lib/queries-music";
import type { AlbumTrackView } from "@/lib/queries-music";
import { qualityLabel } from "@/lib/audio-quality";

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

function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const multiDisc = album.discs.length > 1;

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
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
      <Link
        href={`/music/artist/${album.artist.id}`}
        className="w-fit text-xs font-medium text-text-muted hover:text-text"
      >
        ← {album.artist.name}
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row">
        <CoverImage
          albumId={album.hasCover ? album.id : null}
          version={album.coverVersion}
          title={album.title}
          priority
          sizes="(min-width: 640px) 256px, 60vw"
          className="w-40 shrink-0 rounded-lg border border-border-strong shadow-lg shadow-black/40 sm:w-64"
        />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <h1 className="font-display text-3xl leading-none tracking-wide text-balance sm:text-4xl">
            {album.title}
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
            <AudioCodecBadge codec={codec} quality={quality} />
          </div>
        </div>
      </div>

      {canPlay && (
        <AlbumPlayer albumTitle={album.title} artistName={album.artist.name} tracks={playableTracks} />
      )}
      {drmOnly && (
        <p className="text-xs text-text-faint">Playback unavailable — FairPlay-protected files.</p>
      )}

      <div className="flex flex-col gap-6">
        {album.discs.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-faint">No track data for this album yet.</p>
        ) : (
          album.discs.map((disc) => (
            <div key={disc.disc} className="flex flex-col gap-2">
              {multiDisc && (
                <h2 className="font-mono text-xs uppercase tracking-widest text-text-faint">
                  Disc {disc.disc}
                </h2>
              )}
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
                {disc.tracks.map((t) => {
                  const trackQuality = qualityLabel(t);
                  const differsFromDominant = t.codec !== codec || trackQuality !== quality;
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-6 shrink-0 text-right font-mono text-xs text-text-faint">
                        {t.trackNumber != null ? t.trackNumber.toString().padStart(2, "0") : "—"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                      {differsFromDominant && <AudioCodecBadge codec={t.codec} quality={trackQuality} />}
                      <span className="shrink-0 font-mono text-xs text-text-faint">
                        {formatDuration(t.durationSecs)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
