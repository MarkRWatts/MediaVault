// Wire types for /api/v1/* (IOS_PLAN.md "A versioned native API"). Every
// route in src/app/api/v1 returns one of these, and MediaVaultKit mirrors
// each as a Codable struct by hand — no codegen, because the surface is
// small and most of the shapes below are already the exact, already-stable
// LibraryFilm/FilmDetail/ShowDetail/QueueTrack types the web pages render
// from (src/lib/queries.ts, queries-music.ts, queries-playlists.ts,
// player-types.ts). Field names are kept plain and JSON-friendly on
// purpose: ISO date strings rather than Date, plain numbers rather than
// BigInt, so a Swift Codable struct can mirror a field 1:1 with no custom
// decoding. Nothing here carries Adult media-type data — that type is
// entirely out of scope for the app (IOS_PLAN.md "Out of scope").

import type {
  LibraryFilm,
  VersionView,
  FilmDetail,
  ShowSummary,
  ContinueEpisode,
  ShowDetail,
  SeasonView,
  EpisodeView,
  EpisodeFileView,
} from "@/lib/queries";
import type {
  MusicIndexData,
  ArtistDetail,
  AlbumDetail,
  MusicFavourites,
  FavouriteTrackView,
} from "@/lib/queries-music";
import type { PlaylistSummary, PlaylistDetail } from "@/lib/queries-playlists";
import type { QueueTrack } from "@/lib/player-types";
import type { NetworkKind } from "@/lib/request-network";

/** GET /api/v1/me — who's asking, from what network, and what this server
 *  build can do; the app's one call on every launch. */
export interface MeResponse {
  user: { id: string; name: string; email: string };
  household: { id: string; role: string };
  network: NetworkKind;
  features: { tv: boolean; music: boolean; jellyfin: boolean };
  server: { version: string; minAppBuild: number };
}

/** GET /api/v1/films — the "/" page's shelves plus the full grid, trimmed
 *  to LibraryFilm's card fields (same shape /api/films already sends). */
export interface FilmsResponse {
  shelves: { continueWatching: LibraryFilm[]; favourites: LibraryFilm[] };
  films: LibraryFilm[];
}

/** One version's saved position for the signed-in viewer. */
export interface VersionProgress {
  versionId: number;
  positionSecs: number;
  completed: boolean;
}

/** VersionView plus whether the app can actually play it: only a version
 *  with a jellyfinId is reachable through the Jellyfin-brokered HLS routes
 *  the app uses (IOS_PLAN.md "Video: nothing new" — the local direct-play
 *  tier needs IN_APP_PLAYBACK, which the app never sets). */
export interface FilmVersionV1 extends VersionView {
  playable: boolean;
}

/** GET /api/v1/films/:id */
export interface FilmDetailResponse extends Omit<FilmDetail, "versions"> {
  versions: FilmVersionV1[];
  favourite: boolean;
  progress: VersionProgress[];
}

/** GET /api/v1/shows */
export interface ShowsResponse {
  shows: ShowSummary[];
  continueWatching: ContinueEpisode[];
}

/** One episode file's saved position for the signed-in viewer. */
export interface EpisodeFileProgress {
  episodeFileId: number;
  positionSecs: number;
  completed: boolean;
}

/** EpisodeFileView plus playable, same rule as FilmVersionV1. */
export interface EpisodeFileV1 extends EpisodeFileView {
  playable: boolean;
}

export interface EpisodeV1 extends Omit<EpisodeView, "files"> {
  files: EpisodeFileV1[];
}

export interface SeasonV1 extends Omit<SeasonView, "episodes"> {
  episodes: EpisodeV1[];
}

/** GET /api/v1/shows/:id */
export interface ShowDetailResponse extends Omit<ShowDetail, "seasons"> {
  seasons: SeasonV1[];
  favourite: boolean;
  progress: EpisodeFileProgress[];
}

/** GET /api/v1/music — the "/music" index page's data in one call: the
 *  artist grid's totals/rows, this person's favourites, and their
 *  playlists rail. No `ETag` field: computing "newest updatedAt across
 *  artists/albums/playlists" isn't exposed cheaply by the existing queries
 *  (see report), so a relaunch just re-fetches. */
export interface MusicIndexResponse extends MusicIndexData {
  favourites: MusicFavourites;
  playlists: PlaylistSummary[];
}

/** GET /api/v1/music/artists/:id */
export interface ArtistDetailResponse extends ArtistDetail {
  favourite: boolean;
  /** Which of this artist's albums the viewer has hearted — for the album
   *  tiles' corner hearts, same as the web page. */
  favouriteAlbumIds: number[];
}

/** An album track as a ready-made queue entry, plus the fields the app's
 *  tracklist and QueueModel need that a bare QueueTrack doesn't carry. */
export interface AlbumTrackV1 extends QueueTrack {
  trackNumber: number | null;
  disc: number;
  /** isPlayableCodec(codec) — DRM'd .m4p and unprobed files come back with
   *  this false rather than being omitted, so the tracklist can still show
   *  them (greyed out) the way the web page's per-track badges do. */
  playable: boolean;
}

/** GET /api/v1/music/albums/:id — tracks flattened out of `discs` (disc
 *  number travels on each track instead) since the app queues the whole
 *  album, not a disc at a time. Physical-only albums (owned=false, no
 *  rip) come back with an empty `tracks`, same as the page. */
export interface AlbumDetailResponse extends Omit<AlbumDetail, "discs"> {
  tracks: AlbumTrackV1[];
  favourite: boolean;
  /** Which of this album's tracks the viewer has hearted — for the
   *  tracklist rows' hearts. */
  favouriteTrackIds: number[];
}

/** GET /api/v1/music/favourites */
export interface FavouriteTracksResponse {
  tracks: FavouriteTrackView[];
}

/** GET /api/v1/music/playlists */
export interface PlaylistsResponse {
  playlists: PlaylistSummary[];
}

/** GET /api/v1/music/playlists/:id — the playlist as a ready queue, same
 *  shape the web's playlist page fetches. */
export type PlaylistDetailResponse = PlaylistDetail;

// ---------------------------------------------------------------------------
// Mutations (IOS_PLAN.md "A versioned native API", "To share code rather
// than copy" — the request/response shapes for the routes that wrap
// music-user-state.ts / film-user-state.ts).
// ---------------------------------------------------------------------------

/** PUT/DELETE .../favourite — the shared shape for every favourite toggle
 *  in the app: films, shows, and each of the three music kinds. PUT sets
 *  it on, DELETE sets it off; both are idempotent, so the response is
 *  always the state the caller asked for, not whether anything changed. */
export interface FavouriteResponse {
  favourite: boolean;
}

/** POST /api/v1/music/playlists body. */
export interface CreatePlaylistBody {
  name: string;
}

/** PATCH /api/v1/music/playlists/:id body. */
export interface RenamePlaylistBody {
  name: string;
}

/** PATCH /api/v1/music/playlists/:id response. */
export interface RenamePlaylistResponse {
  id: number;
  name: string;
}

/** DELETE /api/v1/music/playlists/:id response. */
export interface DeletePlaylistResponse {
  ok: true;
}

/** POST .../music/playlists/:id/items body — tracks to append, in order. */
export interface AddPlaylistItemsBody {
  trackIds: number[];
}

/** PUT .../music/playlists/:id/items body — the complete new order of this
 *  playlist's PlaylistItem ids, exactly as PlaylistView's drag-and-drop
 *  reorder sends it on the web. */
export interface ReorderPlaylistItemsBody {
  itemIds: number[];
}
