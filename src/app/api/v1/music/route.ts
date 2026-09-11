// GET /api/v1/music — the app's Music tab: the "/music" index page's data
// in one call — the artist grid (with totals), this person's favourites,
// and their playlists rail. The library is a few thousand rows; no paging,
// same as the web page.
//
// No ETag: IOS_PLAN.md suggests one keyed on "the newest updatedAt across
// artists/albums/playlists", but none of getMusicIndex/getMusicFavourites/
// getUserPlaylists exposes that cheaply (album.updatedAt is there per-row,
// but there's no aggregate MAX() already computed) — adding one means a
// second, heavier query purely for a cache header, so this is skipped for
// now; a relaunch just re-fetches.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getMusicIndex, getMusicFavourites } from "@/lib/queries-music";
import { getUserPlaylists } from "@/lib/queries-playlists";
import type { MusicIndexResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const [index, favourites, playlists] = await Promise.all([
    getMusicIndex(),
    getMusicFavourites(gate.userId),
    getUserPlaylists(gate.userId),
  ]);

  const body: MusicIndexResponse = { ...index, favourites, playlists };
  return NextResponse.json(body);
}
