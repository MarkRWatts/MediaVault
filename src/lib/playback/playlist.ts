// Renders the two playlists a stream key serves (V4_PLAN.md, "Playlists"):
// `master.m3u8` (one variant, with CODECS/RESOLUTION/BANDWIDTH -- "AVPlayer
// is happier with a master") and `main.m3u8`, the VOD media playlist built
// straight from the segment table. Pure string building: the table is
// already decided (see ../video-playback.ts's HLS_SEGMENT_SECS and the
// keyframe-derived table other engine modules build), so nothing here
// touches ffmpeg or the filesystem.

import { MSE_AUDIO_CODEC, MSE_VIDEO_CODEC } from "../video-playback";
import type { SegmentContainer } from "./decisions";
import { INIT_SEGMENT_NAME } from "./fmp4";
import { segmentUrlName } from "./stream-key";
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

/**
 * The CODECS video entry for copied HEVC, from what the source actually is
 * rather than MSE_VIDEO_CODEC's one-size "hvc1.1.6.L120.B0" (Main, level
 * 4): a 10-bit source is Main 10 (profile 2, compatibility flag 4), and a
 * picture taller than 1080 lines needs level 5.1 (L153). A player sizes up
 * its decoder, and on Apple TV its display mode, from this.
 */
export function hevcCodecString(facts: { pixFmt: string | null; height: number }): string {
  const tenBit = (facts.pixFmt ?? "").includes("10");
  const level = facts.height > 1080 ? "L153" : "L123";
  return tenBit ? `hvc1.2.4.${level}.B0` : `hvc1.1.6.${level}.B0`;
}

/** The master playlist's VIDEO-RANGE for a source's transfer function:
 *  "PQ" for HDR10/Dolby Vision's SMPTE ST 2084, "HLG" for ARIB STD-B67,
 *  nothing (SDR, the attribute's default) otherwise. Tells an Apple TV set
 *  to Match Content to switch the display into HDR before playing.
 *
 *  Only for fMP4 segments: AVPlayer refuses a PQ variant of this engine's
 *  MPEG-TS segments outright (-1002), so getMasterPlaylist gives it to fMP4
 *  streams alone. */
export function videoRangeFor(colorTransfer: string | null | undefined): "PQ" | "HLG" | undefined {
  if (colorTransfer === "smpte2084") return "PQ";
  if (colorTransfer === "arib-std-b67") return "HLG";
  return undefined;
}

export interface MasterPlaylistInput {
  bandwidth: number;
  resolution?: { width: number; height: number };
  /** Already-built CODECS value -- see hlsCodecs above. */
  codecs: string;
  /** See videoRangeFor. */
  videoRange?: "PQ" | "HLG";
  /** Frames per second, for the Apple TV's Match Frame Rate. */
  frameRate?: number;
  /** The Apple-spec master for an fMP4 stream (HLS authoring spec for
   *  Apple devices, and clean under Apple's mediastreamvalidator): version
   *  7, EXT-X-INDEPENDENT-SEGMENTS here rather than in the media playlist,
   *  AVERAGE-BANDWIDTH and CLOSED-CAPTIONS=NONE. */
  fmp4?: boolean;
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
  if (input.frameRate && Number.isFinite(input.frameRate) && input.frameRate > 0) {
    attrs.push(`FRAME-RATE=${input.frameRate.toFixed(3)}`);
  }
  if (input.videoRange) attrs.push(`VIDEO-RANGE=${input.videoRange}`);
  if (input.fmp4) {
    attrs.splice(1, 0, `AVERAGE-BANDWIDTH=${Math.round(input.bandwidth)}`);
    attrs.push("CLOSED-CAPTIONS=NONE");
    return ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-STREAM-INF:${attrs.join(",")}`, input.mainUri, ""].join("\n");
  }

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
 * version 3 is the correct, and sufficient, value for MPEG-TS segments; an
 * fMP4 stream (copied HEVC -- decisions.ts's segmentContainerFor) adds
 * EXT-X-MAP, which needs 6, and is written as 7.
 */
export function renderMainPlaylist(segments: SegmentEntry[], container: SegmentContainer = "ts"): string {
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

  // fMP4 segments need EXT-X-MAP, which needs version 6; 7 is what
  // ffmpeg's own fMP4 HLS writes and what Apple's tools expect.
  const lines = [
    "#EXTM3U",
    container === "fmp4" ? "#EXT-X-VERSION:7" : "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  // An fMP4 stream's master declares it instead (the validator: media
  // playlists SHOULD NOT repeat it).
  if (container !== "fmp4") lines.push("#EXT-X-INDEPENDENT-SEGMENTS");
  if (container === "fmp4") lines.push(`#EXT-X-MAP:URI="${INIT_SEGMENT_NAME}"`);
  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
    lines.push(segmentUrlName(seg.index, container));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}
