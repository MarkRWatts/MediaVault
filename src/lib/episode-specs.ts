// A boxed season set rips to one format: every episode in it carries the same
// disc format, resolution, HDR range and audio layout. Repeating that on all
// fourteen rows of a season is noise, so the show and season pages hoist it
// into a single line at the top and the rows drop it.
//
// "Is it actually the same?" has to be asked of the data rather than assumed,
// though — a show can be half DVD and half Blu-ray, and a multi-cut episode
// puts two different rips under one episode. It's asked field by field: each
// of format, resolution, HDR range and audio is hoisted when every file
// agrees on it, and left on the rows when they don't. Sharpe is why —
// eighteen DVD files at one resolution, sixteen of them stereo and two 5.1,
// so the header honestly says DVD and 720×576 and only the audio mark has to
// repeat down the page. All or nothing would have cost that show its whole
// header line over two files.

import { audioBadge, type AudioBadgeInfo } from "@/lib/audio";
import type { EpisodeFileView, SeasonView } from "@/lib/queries";
import type { Format } from "@/lib/constants";

/** A file's audio in both its renderings: one badge per track in stream
 *  order, and `summary`, the legacy pre-rendered string that stands in when
 *  there are no tracks (a file probed before EpisodeAudioTrack existed).
 *  They travel together because they are one field — what hoists one hoists
 *  the other. */
export interface SpecAudio {
  tracks: AudioBadgeInfo[];
  summary: string | null;
}

/** What a spec line says. A header's line and whatever a row has left to add
 *  are the same shape: a null field is one this line doesn't draw, either
 *  because a line above it already did or because there is nothing to draw
 *  (an SDR rip has no HDR mark whoever states it). */
export interface Spec {
  format: Format | null;
  resolution: string | null;
  videoRange: string | null;
  audio: SpecAudio | null;
}

export function fileSpec(file: EpisodeFileView): Spec {
  return {
    format: file.format,
    resolution: file.resolution,
    videoRange: file.videoRange,
    audio: {
      tracks: file.audioTracks.map((a) => audioBadge(a.codec, a.profile, a.channels, a.layout)),
      summary: file.audioSummary,
    },
  };
}

/** Everything the audio marks draw, so two files' audio only counts as
 *  matching when nothing visible about it differs. */
function audioKey(audio: SpecAudio | null): string {
  if (!audio) return "";
  return audio.tracks.length
    ? audio.tracks.map((a) => `${a.label}/${a.sublabel ?? ""}/${a.objectAudio ?? ""}`).join("+")
    : `summary:${audio.summary ?? ""}`;
}

/** The fields every one of these files agrees on, for a show or season
 *  header to state once; the fields they differ on come back null and stay
 *  on the rows. Null when there are no files to summarise at all. */
export function sharedSpec(files: EpisodeFileView[]): Spec | null {
  if (files.length === 0) return null;
  const specs = files.map(fileSpec);
  const first = specs[0];
  const agree = (read: (s: Spec) => string | null) => specs.every((s) => read(s) === read(first));
  return {
    format: agree((s) => s.format) ? first.format : null,
    resolution: agree((s) => s.resolution) ? first.resolution : null,
    videoRange: agree((s) => s.videoRange) ? first.videoRange : null,
    audio: agree((s) => audioKey(s.audio)) ? first.audio : null,
  };
}

/** `spec` minus every field `hoisted` has already said: what a season header
 *  adds to the show's line, and what a row still has to add to both. */
export function specExcept(spec: Spec, hoisted: Spec | null): Spec {
  return {
    format: hoisted?.format ? null : spec.format,
    resolution: hoisted?.resolution ? null : spec.resolution,
    videoRange: hoisted?.videoRange ? null : spec.videoRange,
    audio: hoisted?.audio ? null : spec.audio,
  };
}

export function seasonFiles(season: SeasonView): EpisodeFileView[] {
  return season.episodes.flatMap((e) => e.files);
}

export function showFiles(seasons: SeasonView[]): EpisodeFileView[] {
  return seasons.flatMap(seasonFiles);
}
