// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import Link from "next/link";
import CoverImage from "@/components/CoverImage";
import AlbumCardHeart from "@/components/music/AlbumCardHeart";
import PhysicalAddForm from "@/components/PhysicalAddForm";
import CollapsibleSection from "@/components/CollapsibleSection";
import FavouriteTracksTile from "@/components/music/FavouriteTracksTile";
import { getMusicIndex, getArtistDetail, getMusicFavourites } from "@/lib/queries-music";
import { requireMemberOrRedirect } from "@/lib/require-member";
import type { MusicIndexArtist, FavouriteAlbumView } from "@/lib/queries-music";

// Shared by the main artist grid and the favourites shelf, so both render
// the same card. `variousAlbumCount` only matters for the Compilations
// pseudo-artist (see below) — every other artist ignores it.
function ArtistCard({ artist, variousAlbumCount }: { artist: MusicIndexArtist; variousAlbumCount: number }) {
  return (
    <Link
      href={`/music/artist/${artist.id}`}
      className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <CoverImage
        src={artist.hasPhoto ? `/api/artist-image/${artist.id}/photo` : null}
        albumId={artist.coverAlbumId}
        version={artist.coverVersion}
        title={artist.name}
        className="w-full border-b border-border"
      />
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{artist.name}</h3>
        <span className="mt-auto font-mono text-xs text-text-faint">
          {artist.various
            ? `${variousAlbumCount} album${variousAlbumCount === 1 ? "" : "s"}`
            : `${artist.ownedStudio}/${artist.totalStudio}`}
        </span>
      </div>
    </Link>
  );
}

// Favourite-albums shelf card — simpler than the artist/library cards
// (title + artist name only, no owned/total fraction).
function FavouriteAlbumCard({ album }: { album: FavouriteAlbumView }) {
  return (
    <Link
      href={`/music/album/${album.id}`}
      className="hover-lift relative block overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      {/* Every album on this shelf is a favourite by definition; the heart
          is the way off it. */}
      <AlbumCardHeart albumId={album.id} title={album.title} favourite />
      <CoverImage
        albumId={album.hasCover ? album.id : null}
        version={album.coverVersion}
        title={album.title}
        className="w-full"
      />
      <div className="flex flex-col gap-0.5 p-2.5">
        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-text">{album.title}</h3>
        <span className="text-[11px] text-text-faint">{album.artistName}</span>
      </div>
    </Link>
  );
}

const SHELF_ROW = "flex gap-3 overflow-x-auto pb-2";
const ARTIST_GRID = "grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5 @5xl:grid-cols-6";

function ArtistGrid({
  artists,
  variousAlbumCount,
}: {
  artists: MusicIndexArtist[];
  variousAlbumCount: number;
}) {
  return (
    <div className={ARTIST_GRID}>
      {artists.map((a) => (
        <ArtistCard key={a.id} artist={a} variousAlbumCount={variousAlbumCount} />
      ))}
    </div>
  );
}

export default async function MusicPage() {
  const { userId } = await requireMemberOrRedirect();
  const [{ totals, artists }, favourites] = await Promise.all([getMusicIndex(), getMusicFavourites(userId)]);

  // The Compilations pseudo-artist (various=true) skips Discogs matching
  // entirely, so its studio counters are always 0/0 — getMusicIndex has no
  // "total albums" field to fall back on, so pull its own detail (studio +
  // shelf) for a plain album count instead of a misleading "0/0" fraction.
  const variousArtist = artists.find((a) => a.various) ?? null;
  const variousAlbumCount = variousArtist
    ? await getArtistDetail(variousArtist.id).then((d) => (d ? d.studio.length + d.shelf.length : 0))
    : 0;

  const hasFavourites = favourites.artists.length > 0 || favourites.albums.length > 0 || favourites.trackCount > 0;

  // Split the index grid by playability: vinyl-only artists have nothing
  // the app can actually play (see MusicIndexArtist.vinylOnly).
  const digitalArtists = artists.filter((a) => !a.vinylOnly);
  const vinylOnlyArtists = artists.filter((a) => a.vinylOnly);

  const tiles: { label: string; value: number | string; href?: string }[] = [
    { label: "Artists", value: totals.artists },
    { label: "Albums owned", value: totals.albumsOwned },
    { label: "Tracks", value: totals.tracks },
    { label: "Lossless", value: `${totals.losslessPct}%` },
    { label: "On CD", value: totals.cdOwned, href: "/music/formats" },
    { label: "On vinyl", value: totals.vinylOwned, href: "/music/formats" },
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
          <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-6">
            {tiles.map((t) => {
              const inner = (
                <>
                  <span className="font-display text-3xl leading-none text-text">{t.value}</span>
                  <span className="text-[10px] uppercase leading-tight tracking-widest text-text-faint">
                    {t.label}
                  </span>
                </>
              );
              const tileClass =
                "flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3.5";
              return t.href ? (
                <Link key={t.label} href={t.href} className={`${tileClass} hover-lift transition-colors hover:border-border-strong`}>
                  {inner}
                </Link>
              ) : (
                <div key={t.label} className={tileClass}>
                  {inner}
                </div>
              );
            })}
          </div>
        )}

        {/* Physical-only albums have nothing to do with the scanned digital
            library, so this stays reachable even before a scan has ever
            run — an empty artist list must not hide it. */}
        <PhysicalAddForm />

        {hasFavourites && (
          <div className="flex flex-col gap-6">
            <FavouriteTracksTile count={favourites.trackCount} />

            {favourites.artists.length > 0 && (
              <CollapsibleSection
                storageKey="music:Favourite artists"
                title="Favourite artists"
                count={favourites.artists.length}
                noun="artist"
              >
                <div className={SHELF_ROW}>
                  {favourites.artists.map((a) => (
                    <div key={a.id} className="w-36 shrink-0">
                      <ArtistCard artist={a} variousAlbumCount={variousAlbumCount} />
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {favourites.albums.length > 0 && (
              <CollapsibleSection
                storageKey="music:Favourite albums"
                title="Favourite albums"
                count={favourites.albums.length}
                noun="album"
              >
                <div className={SHELF_ROW}>
                  {favourites.albums.map((al) => (
                    <div key={al.id} className="w-36 shrink-0">
                      <FavouriteAlbumCard album={al} />
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>
        )}

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
          <>
            {digitalArtists.length > 0 && (
              <CollapsibleSection
                storageKey="music:Digital & CD"
                title="Digital & CD"
                count={digitalArtists.length}
                noun="artist"
              >
                <ArtistGrid artists={digitalArtists} variousAlbumCount={variousAlbumCount} />
              </CollapsibleSection>
            )}

            {/* Vinyl you own nothing playable of — separated out because
                nothing in this shelf can actually be played through the
                app (see MusicIndexArtist.vinylOnly). */}
            {vinylOnlyArtists.length > 0 && (
              <CollapsibleSection
                storageKey="music:Vinyl only"
                title="Vinyl only"
                count={vinylOnlyArtists.length}
                noun="artist"
              >
                <ArtistGrid artists={vinylOnlyArtists} variousAlbumCount={variousAlbumCount} />
              </CollapsibleSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}
