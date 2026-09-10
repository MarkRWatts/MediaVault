// Shapes shared between the music player engine (src/lib/player-engine.ts,
// client-only), the React provider around it (components/player), and the
// server code that builds queues for it (album page, favourites/playlist
// queries). Deliberately free of any engine or browser import so a Server
// Component can type a `QueueTrack[]` prop without dragging Web Audio code
// into its module graph.

/** One playable track as handed to the engine — everything the Now
 *  Playing card and queue rows need to render without another fetch. */
export interface QueueTrack {
  trackId: number;
  title: string;
  artist: string;
  albumId: number;
  albumTitle: string;
  /** Whether /api/cover/<albumId> has art; false renders the title fallback. */
  hasCover: boolean;
  /** Cover cache-buster (queries' coverVersion). */
  coverVersion: number | null;
  /** DB estimate; the engine swaps in the decoded buffer's real duration. */
  durationSecs: number | null;
  codec: string | null;
}

/** A track once it is in the queue. `key` is assigned by the engine and is
 *  unique per enqueue, so the same track can sit in the queue twice (an
 *  album plus a favourites list that contains it) and every engine map can
 *  be keyed by it — queue positions shift on every edit, track ids repeat. */
export interface QueueEntry extends QueueTrack {
  key: number;
}

export type PlayerStatus = "idle" | "loading" | "playing" | "paused";

/** What the queue was built from, for the "Playing from …" line. */
export type PlaybackContext =
  | { kind: "album"; albumId: number; title: string }
  | { kind: "playlist"; playlistId: number; title: string }
  | { kind: "favourites" }
  | { kind: "queue" };

/** A track that failed to fetch/decode — set when prefetch()'s load rejects,
 *  cleared the next time any entry schedules successfully. Surfaced as a
 *  dismissable banner (see PlayerProvider) since the engine otherwise only
 *  console.warn's and silently skips ahead, which looks like normal
 *  playback with no sound on a network that's dropping/timing out the
 *  fetch — see the off-LAN iPhone report this was added for. */
export interface PlayerLoadError {
  title: string;
  message: string;
}

export interface PlayerSnapshot {
  status: PlayerStatus;
  /** Every entry in insertion order — the natural order shuffle restores. */
  queue: QueueEntry[];
  /** Entry keys in play order (identical to queue's keys when shuffle is off). */
  order: number[];
  currentKey: number | null;
  current: QueueEntry | null;
  /** Real decoded duration of the current entry once known, else its DB estimate. */
  duration: number | null;
  shuffle: boolean;
  repeat: boolean;
  volume: number;
  context: PlaybackContext | null;
  lastError: PlayerLoadError | null;
}

export const DEFAULT_VOLUME = 0.85;

/** The one snapshot the server render and the first client render agree
 *  on — nothing has ever been queued at that point. Also what
 *  useSyncExternalStore hands back on the server. */
export const EMPTY_SNAPSHOT: PlayerSnapshot = Object.freeze({
  status: "idle",
  queue: [],
  order: [],
  currentKey: null,
  current: null,
  duration: null,
  shuffle: false,
  repeat: false,
  volume: DEFAULT_VOLUME,
  context: null,
  lastError: null,
}) as PlayerSnapshot;
