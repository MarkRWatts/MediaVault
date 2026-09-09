// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

// The artist page groups albums by the FORMAT you own them on — "Digital &
// CD" and Vinyl — each a release-order timeline, plus a folded "Not owned"
// list for the Discogs gap-tracking placeholders. Studio vs. compilation
// vs. EP is deliberately not a grouping here (it's a tag on the album
// page): the collection is thought about as shelves, not as a discography.
// CD and digital share the Digital list because the rip almost always came
// from the CD (Album.digitalSource records the handful of exceptions) — a
// "+CD" badge marks the ones also on the shelf; an album on vinyl and
// digitally sits in both lists. The Owned / Missing / Complete
// tiles are the one studio-only thing left, because Discogs only counts
// studio releases and the percentage is only honest against that.

import Link from "next/link";
import { notFound } from "next/navigation";
import CoverImage from "@/components/CoverImage";
import CollapsibleSection from "@/components/CollapsibleSection";
import ArtistActions from "@/components/music/ArtistActions";
import AlbumCardHeart from "@/components/music/AlbumCardHeart";
import { getArtistDetail } from "@/lib/queries-music";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { getArtistUserState } from "@/lib/music-user-state";
import type { ArtistCatalogueAlbum } from "@/lib/queries-music";

// One tile for every list. Owned tiles (in any format) link to the album
// page and carry the corner heart; a "Not owned" placeholder has nothing
// to view or favourite, so it's a greyed, dashed non-link.
function AlbumTile({
  album,
  favourite,
  badge,
}: {
  album: ArtistCatalogueAlbum;
  favourite: boolean;
  /** Small format chip beside the year ("+CD" in the Digital list). */
  badge?: string | null;
}) {
  const isPlaceholder = !album.owned && album.physicalMedia.length === 0;

  const body = (
    <div
      className={`relative flex flex-col overflow-hidden rounded-lg border ${
        isPlaceholder ? "border-dashed border-border/60 bg-bg-elevated/40" : "border-border bg-bg-elevated"
      }`}
    >
      {!isPlaceholder && <AlbumCardHeart albumId={album.id} title={album.title} favourite={favourite} />}
      <CoverImage
        albumId={album.hasCover ? album.id : null}
        version={album.coverVersion}
        title={album.title}
        className={isPlaceholder ? "w-full grayscale opacity-45" : "w-full"}
      />
      <div className="flex flex-col gap-0.5 p-2.5">
        <h3
          className={`line-clamp-2 text-xs font-semibold leading-snug ${isPlaceholder ? "text-text-muted" : "text-text"}`}
        >
          {album.title}
        </h3>
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-text-faint">{album.year ?? "—"}</span>
          {badge && (
            <span className="rounded border border-format-cd-border bg-format-cd-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest leading-none text-format-cd">
              {badge}
            </span>
          )}
        </span>
      </div>
    </div>
  );

  return isPlaceholder ? (
    <div aria-label={`${album.title} — not owned`}>{body}</div>
  ) : (
    <Link href={`/music/album/${album.id}`} className="hover-lift block">
      {body}
    </Link>
  );
}

function byYearAsc(a: ArtistCatalogueAlbum, b: ArtistCatalogueAlbum): number {
  if (a.year === null && b.year === null) return a.title.localeCompare(b.title);
  if (a.year === null) return 1;
  if (b.year === null) return -1;
  return a.year - b.year;
}

function decadeLabel(year: number | null): string {
  if (year == null) return "UNDATED"; // pre-styled caps: the label span no longer uppercases (see below)
  return `${Math.floor(year / 10) * 10}s`;
}

// Input is year-sorted (nulls last), so a consecutive-run grouping is enough.
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

function DecadeTimeline({
  albums,
  favourites,
  badgeFor,
}: {
  albums: ArtistCatalogueAlbum[];
  favourites: Set<number>;
  badgeFor?: (a: ArtistCatalogueAlbum) => string | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groupByDecade(albums).map((group) => (
        <div key={group.label} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {/* No `uppercase` here — it would render "1990s" as "1990S". */}
            <span className="shrink-0 font-mono text-xs tracking-widest text-text-faint">{group.label}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className={ALBUM_GRID}>
            {group.items.map((a) => (
              <AlbumTile key={a.id} album={a} favourite={favourites.has(a.id)} badge={badgeFor?.(a)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// The format lists, in shelf order. Empty ones don't render.
const FORMAT_LISTS: {
  title: string;
  pick: (a: ArtistCatalogueAlbum) => boolean;
  badgeFor?: (a: ArtistCatalogueAlbum) => string | null;
}[] = [
  {
    title: "Digital",
    pick: (a) => a.owned || a.physicalMedia.includes("CD"),
    // "+CD" = the rip plus the disc; a bare "CD" = disc only, no files.
    badgeFor: (a) => (a.physicalMedia.includes("CD") ? (a.owned ? "+CD" : "CD") : null),
  },
  { title: "Vinyl", pick: (a) => a.physicalMedia.includes("VINYL") },
];

export default async function ArtistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await requireMemberOrRedirect();
  const { id } = await params;
  const artistId = Number(id);
  if (!Number.isInteger(artistId)) notFound();

  const [detail, userState] = await Promise.all([getArtistDetail(artistId), getArtistUserState(userId, artistId)]);
  if (!detail) notFound();
  const favourites = new Set(userState.favouriteAlbumIds);

  const { artist, studio, shelf, stats, gapTrackingOff } = detail;
  const missing = stats.total - stats.owned;

  // Every album row for this artist, whatever Discogs calls it. studio and
  // shelf are disjoint by kind, but dedupe by id anyway.
  const byId = new Map<number, ArtistCatalogueAlbum>();
  for (const a of [...studio, ...shelf]) byId.set(a.id, a);
  const all = [...byId.values()].sort(byYearAsc);
  const notOwned = all.filter((a) => !a.owned && a.physicalMedia.length === 0);
  const formatLists = FORMAT_LISTS.map((f) => ({ ...f, albums: all.filter(f.pick) })).filter(
    (f) => f.albums.length > 0,
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4">
        <Link href="/music" className="w-fit text-xs font-medium text-text-muted hover:text-text">
          ← Music
        </Link>

        {artist.hasBackdrop && (
          // One hero image per artist page load, not worth next/image's machinery.
          <img
            src={`/api/artist-image/${artist.id}/backdrop`}
            alt=""
            className="h-40 w-full rounded-lg border border-border-strong object-cover sm:h-56"
          />
        )}

        <div className="flex items-center gap-4">
          {artist.hasPhoto && (
            <img
              src={`/api/artist-image/${artist.id}/photo`}
              alt={`${artist.name} portrait`}
              className="h-16 w-16 shrink-0 rounded-full border border-border-strong object-cover sm:h-20 sm:w-20"
            />
          )}
          <div>
            <h1 className="font-display text-4xl leading-none tracking-wide text-balance sm:text-5xl">
              {artist.name}
            </h1>
            {artist.disambiguation && (
              <p className="mt-1 text-sm text-text-faint">{artist.disambiguation}</p>
            )}
          </div>
          <div className="ml-auto shrink-0">
            <ArtistActions artistId={artist.id} name={artist.name} favourite={userState.favourite} />
          </div>
        </div>

        {artist.bio && (
          <p className="max-w-2xl whitespace-pre-line text-sm leading-relaxed text-text-muted">{artist.bio}</p>
        )}

        {!artist.various && (
          <div className="flex flex-col gap-2">
            {/* Discogs only counts studio releases, so this is the one
                place the page still thinks in "studio albums" — say so. */}
            <span className="text-[10px] uppercase tracking-widest text-text-faint">
              Studio discography · Discogs
            </span>
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
            {gapTrackingOff && (
              <p className="text-xs text-text-faint">
                Discogs lists {stats.total} studio albums for this artist — gap tracking starts once at
                least 2 (and 20%) are owned.
              </p>
            )}
          </div>
        )}
      </div>

      {all.length === 0 ? (
        <p className="py-16 text-center text-sm text-text-faint">No albums yet.</p>
      ) : (
        <>
          {formatLists.map((list) => (
            <CollapsibleSection
              key={list.title}
              storageKey={`music-artist:${list.title}`}
              title={list.title}
              count={list.albums.length}
              noun="album"
            >
              <DecadeTimeline albums={list.albums} favourites={favourites} badgeFor={list.badgeFor} />
            </CollapsibleSection>
          ))}

          {notOwned.length > 0 && (
            <CollapsibleSection
              storageKey="music-artist:Not owned"
              title="Not owned"
              count={notOwned.length}
              noun="album"
              defaultCollapsed
            >
              <DecadeTimeline albums={notOwned} favourites={favourites} />
            </CollapsibleSection>
          )}
        </>
      )}
    </div>
  );
}
