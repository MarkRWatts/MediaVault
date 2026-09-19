// Renders the two playlists a stream key serves (V4_PLAN.md, "Playlists"):
// `master.m3u8` (one variant, with CODECS/RESOLUTION/BANDWIDTH -- "AVPlayer
// is happier with a master") and `main.m3u8`, the VOD media playlist built
// straight from the segment table. Pure string building: the table is
// already decided (see ../video-playback.ts's HLS_SEGMENT_SECS and the
// keyframe-derived table other engine modules build), so nothing here
// touches ffmpeg or the filesystem.

import { MSE_AUDIO_CODEC, MSE_VIDEO_CODEC } from "../video-playback";
import { segmentFileName } from "./stream-key";
import type { SegmentEntry } from "./types";

/**
 * RFC 6381 CODECS value for the master playlist's #EXT-X-STREAM-INF, e.g.
 * `"avc1.640028,mp4a.40.2"`. Reuses video-playback.ts's MSE codec maps
 * rather than duplicating them: the codec strings mseMimeForVariant needs
 * for a MediaSource.isTypeSupported probe are exactly what CODECS wants too
 * -- RFC 6381 strings describe elementary streams, not a container, so the
 * same map serves fMP4 (the source video-playback.ts was written for) and
 * the MPEG-TS segments this engine actually emits.
 */
export function hlsCodecs(videoCodec: string, audioCodec: string | null): string {
  const v = MSE_VIDEO_CODEC[videoCodec];
  if (!v) throw new Error(`no RFC 6381 codec string for video codec: ${videoCodec}`);
  if (audioCodec === null) return v;
  const a = MSE_AUDIO_CODEC[audioCodec];
  if (!a) throw new Error(`no RFC 6381 codec string for audio codec: ${audioCodec}`);
  return `${v},${a}`;
}

export interface MasterPlaylistInput {
  bandwidth: number;
  resolution?: { width: number; height: number };
  /** Already-built CODECS value -- see hlsCodecs above. */
  codecs: string;
  mainUri: string;
}

export function renderMasterPlaylist(input: MasterPlaylistInput): string {
  if (!Number.isFinite(input.bandwidth) || input.bandwidth <= 0) {
    throw new Error(`invalid bandwidth: ${input.bandwidth}`);
  }
  const attrs = [`BANDWIDTH=${Math.round(input.bandwidth)}`];
  if (input.resolution) {
    const { width, height } = input.resolution;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`invalid resolution: ${width}x${height}`);
    }
    attrs.push(`RESOLUTION=${width}x${height}`);
  }
  attrs.push(`CODECS="${input.codecs}"`);

  return [
    "#EXTM3U",
    // See renderMainPlaylist for why version 3 (not 6) is correct here too.
    "#EXT-X-VERSION:3",
    `#EXT-X-STREAM-INF:${attrs.join(",")}`,
    input.mainUri,
    "",
  ].join("\n");
}

/**
 * The VOD media playlist for one stream key's full segment table.
 * `#EXT-X-MEDIA-SEQUENCE:0` is always correct because this always renders
 * the *complete* table from segment 0 -- there is no sliding window, the
 * whole point of computing the table up front (V4_PLAN.md, "Why the first
 * local pipeline was parked").
 *
 * Version: RFC 8216 (HLS) requires a compatibility version bump for a
 * handful of specific features (its "Protocol Version Compatibility"
 * table, S7) -- fractional EXTINF durations need version >= 3, EXT-X-MAP
 * without EXT-X-I-FRAMES-ONLY needs >= 6, EXT-X-KEY METHOD=SAMPLE-AES
 * needs >= 5, and so on. EXT-X-INDEPENDENT-SEGMENTS is *not* in that table
 * -- it has been usable since version 1 -- so it doesn't force a bump on
 * its own. This playlist's EXTINF values are fractional (six decimals), so
 * version 3 is the correct, and sufficient, value; there is no fMP4
 * EXT-X-MAP here (segments are MPEG-TS, V4_PLAN.md "Heads") to require 6.
 */
export function renderMainPlaylist(segments: SegmentEntry[]): string {
  if (segments.length === 0) throw new Error("cannot render a playlist with no segments");
  segments.forEach((s, i) => {
    if (s.index !== i) throw new Error(`segment table is not a complete 0-based sequence at position ${i}`);
    if (!Number.isFinite(s.duration) || s.duration <= 0) throw new Error(`invalid segment duration: ${s.duration}`);
  });

  // TARGETDURATION must be an integer at least as large as every EXTINF
  // duration rounded to the nearest integer (RFC 8216 S4.3.3.1). ceil() of
  // the largest duration always satisfies that: for any x, round(x) <=
  // ceil(x) (they're equal when x is already an integer, and otherwise
  // round(x) is one of floor(x)/ceil(x) while ceil(x) is the larger of the
  // two candidates).
  const targetDuration = Math.ceil(Math.max(...segments.map((s) => s.duration)));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
    lines.push(segmentFileName(seg.index));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}
