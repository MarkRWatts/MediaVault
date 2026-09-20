// A boxed season set rips to one format: every episode in it carries the same
// disc format, resolution, HDR range and audio layout. Repeating that on all
// fourteen rows of a season is noise, so the show and season pages hoist it
// into a single line at the top and the rows drop it.
//
// "Is it actually the same?" has to be asked of the data rather than assumed,
// though — a show can be half DVD and half Blu-ray, and a multi-cut episode
// puts two different rips under one episode. When the files disagree there is
// no honest summary to hoist, so these return null and the rows keep showing
// their own badges.

import { audioBadge, type AudioBadgeInfo } from "@/lib/audio";
import type { EpisodeFileView, SeasonView } from "@/lib/queries";
import type { Format } from "@/lib/constants";

export interface FileSpec {
  format: Format;
  resolution: string;
  videoRange: string | null;
  /** One per audio track, in stream order. Empty for a file probed before
   *  EpisodeAudioTrack existed, which is what `audioSummary` covers. */
  audio: AudioBadgeInfo[];
  /** The legacy pre-rendered string, shown only when `audio` is empty. */
  audioSummary: string | null;
}

export function fileSpec(file: EpisodeFileView): FileSpec {
  return {
    format: file.format,
    resolution: file.resolution,
    videoRange: file.videoRange,
    audio: file.audioTracks.map((a) => audioBadge(a.codec, a.profile, a.channels, a.layout)),
    audioSummary: file.audioSummary,
  };
}

/** Everything the summary line draws, so two files only count as matching
 *  when nothing visible about them differs. */
function specKey(spec: FileSpec): string {
  const audio = spec.audio.length
    ? spec.audio.map((a) => `${a.label}/${a.sublabel ?? ""}/${a.objectAudio ?? ""}`).join("+")
    : `summary:${spec.audioSummary ?? ""}`;
  return [spec.format, spec.resolution, spec.videoRange ?? "", audio].join("|");
}

/** The one spec every file here shares, or null if they differ (or there are
 *  none). Callers treat null as "leave the badges on the rows". */
export function sharedSpec(files: EpisodeFileView[]): FileSpec | null {
  if (files.length === 0) return null;
  const specs = files.map(fileSpec);
  const first = specs[0];
  const key = specKey(first);
  return specs.every((s) => specKey(s) === key) ? first : null;
}

export function seasonFiles(season: SeasonView): EpisodeFileView[] {
  return season.episodes.flatMap((e) => e.files);
}

export function showFiles(seasons: SeasonView[]): EpisodeFileView[] {
  return seasons.flatMap(seasonFiles);
}
