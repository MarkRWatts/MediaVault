// V4_PLAN.md phase 4 cut-over flag: which backend actually serves in-app
// video playback. Every "is this playable" / "is playback available" call
// site (film/show pages, EpisodeRow/EpisodeCard, queries.ts, the /api/v1
// DTOs, the admin status page) reads its answer through the three functions
// below rather than re-deriving it, so the answer moves in exactly one
// place when the flag flips from "jellyfin" to "local".
//
// NOT to be confused with the legacy IN_APP_PLAYBACK=1 env var (read
// directly by src/app/film/[id]/page.tsx's `localPlay` and set by
// scripts/e2e-playback.ts for its own server): that toggles the OLD, parked
// event-playlist pipeline on for testing and predates this engine cut-over
// by a whole design. The two flags are independent -- this module never
// reads IN_APP_PLAYBACK, and PLAYBACK_ENGINE doesn't touch localPlay.

import { jellyfinConfigured } from "@/lib/jellyfin";

export type PlaybackEngine = "jellyfin" | "local";

// Emitted at most once per process -- an unrecognised value is a config
// mistake worth surfacing, but every playback decision in a request calls
// playbackEngine() at least once, and spamming the log on every request
// would drown out everything else.
let warnedInvalidEngine = false;

/** Which engine serves in-app playback right now. Defaults (and falls back
 *  on any unrecognised value) to "jellyfin" -- the safe choice while the
 *  local engine is still being finished (src/lib/playback/*). */
export function playbackEngine(): PlaybackEngine {
  const raw = process.env.PLAYBACK_ENGINE;
  if (raw === "local") return "local";
  if (raw === undefined || raw === "" || raw === "jellyfin") return "jellyfin";
  if (!warnedInvalidEngine) {
    warnedInvalidEngine = true;
    console.warn(`[playback] PLAYBACK_ENGINE=${JSON.stringify(raw)} is not "jellyfin" or "local" -- defaulting to "jellyfin"`);
  }
  return "jellyfin";
}

/** Whether in-app playback can be offered at all right now, independent of
 *  any one file: the local engine is always available (it needs nothing
 *  external once ffmpeg is on the box); Jellyfin needs to actually be
 *  configured. Same rule the film/show pages already applied via
 *  jellyfinConfigured() -- now routed through the engine flag. */
export function playbackAvailable(): boolean {
  return playbackEngine() === "local" ? true : jellyfinConfigured();
}

/**
 * Whether one specific file can be played, given the active engine.
 *
 * - jellyfin: exactly today's rule -- Jellyfin must be configured AND this
 *   file has to have been matched to a Jellyfin library item.
 * - local: the engine can remux or transcode anything ffmpeg can read, so
 *   there's no separate "has a matching item somewhere else" gate to also
 *   satisfy -- whether the file has been probed (videoCodec on record) is
 *   the *whole* rule. "Probed" also implies it's a video file the scanner
 *   could actually open, which is the only thing that could otherwise make
 *   ffmpeg fail outright.
 */
export function isFilePlayable(file: { jellyfinId: string | null; videoCodec: string | null }): boolean {
  if (playbackEngine() === "local") return file.videoCodec !== null;
  return jellyfinConfigured() && file.jellyfinId !== null;
}
