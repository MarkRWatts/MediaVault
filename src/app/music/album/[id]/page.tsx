// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import CoverImage from "@/components/CoverImage";
import AudioCodecBadge from "@/components/AudioCodecBadge";
import { getAlbumDetail } from "@/lib/queries-music";
import type { AlbumTrackView } from "@/lib/queries-music";

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

// The album's "summary" codec badge shown next to the title — whichever
// codec the most tracks share. Per-track badges only render below when a
// track's codec differs from this one (e.g. one bonus MP3 in an otherwise
// ALAC album), so the common case stays quiet.
function dominantCodec(tracks: AlbumTrackView[]): string | null {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    if (!t.codec) continue;
    counts.set(t.codec, (counts.get(t.codec) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [codec, count] of counts) {
    if (count > bestCount) {
      best = codec;
      bestCount = count;
    }
  }
  return best;
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
  const multiDisc = album.discs.length > 1;

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
            <AudioCodecBadge codec={codec} />
          </div>
        </div>
      </div>

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
                {disc.tracks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-6 shrink-0 text-right font-mono text-xs text-text-faint">
                      {t.trackNumber != null ? t.trackNumber.toString().padStart(2, "0") : "—"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                    {t.codec !== codec && <AudioCodecBadge codec={t.codec} />}
                    <span className="shrink-0 font-mono text-xs text-text-faint">
                      {formatDuration(t.durationSecs)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
