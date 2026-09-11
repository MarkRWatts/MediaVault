// GET /api/v1/music/albums/:id — an album's page: its tracks as ready-made
// queue entries (the same mapping the web album page uses, see
// queries-music.ts's albumTrackToQueueTrack) plus `playable` and each
// track's disc/trackNumber, and the viewer's heart on the album and on any
// of its tracks. Physical-only albums (owned=false, no rip) come back
// with an empty `tracks`, same as the page.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getAlbumDetail, albumTrackToQueueTrack, isPlayableCodec } from "@/lib/queries-music";
import { getAlbumUserState } from "@/lib/music-user-state";
import { titleCase } from "@/lib/text-case";
import type { AlbumDetailResponse, AlbumTrackV1 } from "@/lib/api-v1-types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid album id" }, { status: 400 });
  }

  const album = await getAlbumDetail(id);
  if (!album) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const userState = await getAlbumUserState(gate.userId, id);

  // Same title-casing the album page applies before building queue
  // entries, so an app queue and a web queue read identically.
  const displayTitle = titleCase(album.title);
  const tracks: AlbumTrackV1[] = album.discs.flatMap((d) =>
    d.tracks.map((t) => ({
      ...albumTrackToQueueTrack(album, displayTitle, t),
      trackNumber: t.trackNumber,
      disc: d.disc,
      playable: isPlayableCodec(t.codec),
    })),
  );

  const body: AlbumDetailResponse = {
    id: album.id,
    title: album.title,
    year: album.year,
    kind: album.kind,
    owned: album.owned,
    copies: album.copies,
    digitalSource: album.digitalSource,
    hasCover: album.hasCover,
    coverVersion: album.coverVersion,
    trackTotal: album.trackTotal,
    discogsUrl: album.discogsUrl,
    artist: album.artist,
    tracks,
    favourite: userState.favourite,
    favouriteTrackIds: userState.favouriteTrackIds,
  };
  return NextResponse.json(body);
}
