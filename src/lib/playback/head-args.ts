// Builds the ffmpeg argument list for one *head* -- one ffmpeg process
// writing consecutive segments into a stream key's directory, starting at
// segment N (V4_PLAN.md, "Heads"). Pure argument construction: this module
// never spawns ffmpeg, never touches the filesystem, and never guesses --
// every number in the output is either validated input or computed from
// validated input.
//
// ## The segment-completion contract
//
// A half-written segment must never be served, and two heads must never
// corrupt each other's output (V4_PLAN.md, "Heads"). The segment muxer
// (`-f segment`) can't rename a file on close, so this module never asks it
// to write directly into the stream key's real directory. Instead:
//
//   - `outDir` is expected to be a *per-head staging directory*
//     (`.part-<headId>/`, chosen by the caller, not this module) -- segment
//     files land there as plain `seg_%05d.ts`, no temp suffix needed,
//     because the whole directory is provisional.
//   - `-segment_list pipe:1 -segment_list_type csv -segment_list_flags
//     live` makes ffmpeg print one CSV line (`seg_NNNNN.ts,start,end`) to
//     its *stdout* the moment each segment file is closed and its trailer
//     written -- not buffered until the process exits. The engine (not
//     this module) reads that stream line by line: a line means the named
//     file in `outDir` is complete and safe to rename into the real
//     directory.
//
// Verified against a real ffmpeg build (mwader/static-ffmpeg:latest,
// 9.0.1, matches the segment muxer jellyfin-ffmpeg also ships), 19 Sep
// 2026, since there is no ffmpeg on this Mac's PATH:
//   - `-segment_list pipe:1 -segment_list_type csv -segment_list_flags
//     live` is a real, documented combination (`ffmpeg -h muxer=segment`).
//   - Run against a `-re` (realtime) source with 2s segments, the CSV
//     lines arrived on stdout as each segment boundary passed in realtime
//     (1 line at ~t=2s, 2 lines at ~t=4s, ...), not all at once at exit --
//     confirming "live" means what the docs say and this really is a
//     completion signal, not a post-hoc summary.
//   - `-protocol_whitelist file,pipe`, placed as an input option before
//     `-i` (as below), does not break the output side: a real run with a
//     real file `-i`, `-c:v copy -c:a copy` segment output to `outDir`,
//     and `-segment_list pipe:1` all together produced correct segment
//     files *and* a correct CSV list on stdout.
//   - `-segment_times 1.0,3.0` against a source with keyframes exactly
//     there produced exactly 3 segments split at those times (verified via
//     the emitted CSV), confirming the relative-cuts arithmetic below.
//   - The top-level `-copyts` alone does *not* keep a copied-video
//     segment's baked-in PTS absolute: the mpegts muxer has its own
//     rebasing switch, off by default in a way that isn't fixed by a
//     bare top-level `-mpegts_copyts 1`. See the comment at
//     `-segment_format_options` below for the fix and the restart-
//     consistency test that found it.
//
// ## Timestamps
//
// `-copyts` keeps ffmpeg's internal packet timestamps equal to the
// source's own PTS. That is the assumption `-force_key_frames`'s absolute
// time list and the seek arithmetic below both rely on: every time in
// `SegmentEntry.start` is a source-timeline second, and with `-copyts` it
// is also the timestamp ffmpeg itself is working with -- no rebasing to
// account for. This is asserted, not verified by a unit test here (pure
// functions can't run ffmpeg); the integration test in a later phase
// checks a produced segment's actual first timestamp against the table.

import {
  audioTranscodeBitrate,
  audioTranscodeChannels,
  HLS_SEGMENT_SECS,
  REMOTE_AUDIO_BITRATE,
  REMOTE_VIDEO_MAXRATE,
  type StreamAction,
  type Variant,
  type VideoPlaybackPlan,
} from "../video-playback";
import type { HwAccel, SegmentEntry, SourceFacts } from "./types";

export const DEFAULT_RENDER_DEVICE = "/dev/dri/renderD128";

// Seek offsets, in seconds (V4_PLAN.md, "Heads"): ffmpeg subtracts 3/23 s
// (~0.1304s) from a `-ss` target when decoding video with B-frames -- true
// for essentially every copied H.264/HEVC source in this library -- so
// `-ss <keyframe>` alone lands one keyframe early (seen in the VM
// experiment, 19 Sep 2026). Seeking to `keyframe + 0.135` instead puts
// ffmpeg's *effective* target at `keyframe + 0.135 - 0.1304 ≈ keyframe +
// 0.0046`: solidly inside [keyframe, nextKeyframe) for any real GOP.
const COPY_SEEK_OFFSET_SECS = 0.135;

// The offset above must not push the effective seek target past the
// *following* keyframe, or ffmpeg lands one keyframe late instead of one
// early. Clamp so the effective target stays at most `nextKeyframe -
// 0.005` below it: 0.005s of slack under the 0.1304 backoff, in case a
// real file's actual backoff isn't exactly 3/23.
const SEEK_CLAMP_MARGIN_SECS = 0.13 - 0.005;

// Tolerance for treating a keyframe equal to the segment's own start time
// as "not the next one" -- table[N].start is itself a keyframe (segment
// table boundaries only ever land on keyframes for copied video), so the
// search for "the next keyframe after this one" must skip it.
const KEYFRAME_EPSILON_SECS = 1e-6;

// -segment_time_delta per tier -- see where it is pushed.
const COPY_SEGMENT_TIME_DELTA = "0.02";
const TRANSCODE_SEGMENT_TIME_DELTA = "0.5";

export interface HeadAudioInput {
  /** ffprobe's absolute stream index, or null when the file has no audio
   *  stream at all. */
  streamIndex: number | null;
  action: StreamAction | "none";
  /** Source channel count, for sizing a transcoded track -- see
   *  audioTranscodeChannels in video-playback.ts. Unused for "copy"/"none". */
  sourceChannels: number | null;
}

export interface BuildHeadArgsInput {
  /** Absolute path to the source file. */
  input: string;
  plan: VideoPlaybackPlan;
  variant: Variant;
  audio: HeadAudioInput;
  /** The full, immutable segment table for this stream key (V4_PLAN.md,
   *  "Segment table") -- a complete 0-based sequence, not a slice. */
  segments: SegmentEntry[];
  /** The segment this head starts writing from. */
  startIndex: number;
  /** The head's staging directory -- see the file header's completion
   *  contract. Interpolated into the output path verbatim (it is one of
   *  the two paths this module is allowed to interpolate). */
  outDir: string;
  hwaccel: HwAccel;
  source: SourceFacts;
  /** Source keyframe timestamps, in seconds, ascending. Required when the
   *  video is copied and startIndex > 0 (the seek target has to be clamped
   *  against the next real keyframe); ignored otherwise. */
  keyframes?: number[];
  /** Render node path for `-vaapi_device`/`-qsv_device`. */
  renderDevice?: string;
}

function formatSeconds(t: number): string {
  if (!Number.isFinite(t)) throw new Error(`non-finite time: ${t}`);
  return t.toFixed(6);
}

function annexBBitstreamFilter(outputVideoCodec: string): string {
  return outputVideoCodec === "hevc" || outputVideoCodec === "h265" ? "hevc_mp4toannexb" : "h264_mp4toannexb";
}

/**
 * The seek target for restarting a copied-video head at a keyframe, per
 * the "Seeking to a keyframe" rule in V4_PLAN.md's "Heads" section -- see
 * the constants above for the arithmetic this implements.
 */
function clampCopySeekTarget(keyframeStart: number, keyframes: readonly number[]): number {
  const raw = keyframeStart + COPY_SEEK_OFFSET_SECS;
  const nextKeyframe = keyframes.find((kf) => kf > keyframeStart + KEYFRAME_EPSILON_SECS);
  if (nextKeyframe === undefined) return raw;
  return Math.min(raw, nextKeyframe + SEEK_CLAMP_MARGIN_SECS);
}

/** Cut points for `-segment_times`, relative to this head's first packet
 *  (V4_PLAN.md: "cuts relative to this head's first packet"). Empty when N
 *  is the last segment -- there is nothing left to cut. */
function relativeCutTimes(segments: SegmentEntry[], startIndex: number): string[] {
  const base = segments[startIndex].start;
  return segments.slice(startIndex + 1).map((s) => formatSeconds(s.start - base));
}

/** Absolute boundary times for `-force_key_frames`. With `-copyts` (see
 *  the file header), the encoder's own timestamps equal the source
 *  timeline, so these are the table's `start` values unmodified -- not
 *  relative to the head, unlike `-segment_times` above. */
function futureBoundaryTimes(segments: SegmentEntry[], startIndex: number): string[] {
  return segments.slice(startIndex + 1).map((s) => formatSeconds(s.start));
}

function computeGop(fps: number | null): number {
  if (fps === null || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`a positive fps is required for hardware GOP alignment, got: ${fps}`);
  }
  return Math.round(fps * HLS_SEGMENT_SECS);
}

/** `-qp`/`-global_quality` for Original, or a fixed bitrate ceiling for
 *  Remote -- same shape for both hardware encoders, only the quality
 *  option's name differs (V4_PLAN.md, "Hardware switch"). */
function hwQualityArgs(hwaccel: "vaapi" | "qsv", variant: Variant): string[] {
  if (variant === "remote") {
    return ["-b:v", REMOTE_VIDEO_MAXRATE, "-maxrate", REMOTE_VIDEO_MAXRATE, "-bufsize", "6M"];
  }
  return hwaccel === "vaapi" ? ["-qp", "20"] : ["-global_quality", "20"];
}

export function buildHeadArgs(input: BuildHeadArgsInput): string[] {
  const { plan, variant, audio, segments, outDir, hwaccel, source } = input;
  const N = input.startIndex;

  if (segments.length === 0) throw new Error("segment table is empty");
  segments.forEach((s, i) => {
    if (s.index !== i) throw new Error(`segment table is not a complete 0-based sequence at position ${i}`);
  });
  if (!Number.isInteger(N) || N < 0 || N >= segments.length) {
    throw new Error(`startIndex out of range: ${N}`);
  }
  if (!input.input) throw new Error("input path is required");
  if (!outDir) throw new Error("outDir is required");
  if (audio.action === "none" && audio.streamIndex !== null) {
    throw new Error("audio action is none but a stream index was given");
  }
  if (audio.action !== "none" && audio.streamIndex === null) {
    throw new Error("audio action requires a stream index");
  }
  if (audio.streamIndex !== null && (!Number.isInteger(audio.streamIndex) || audio.streamIndex < 0)) {
    throw new Error(`invalid audio stream index: ${audio.streamIndex}`);
  }

  const renderDevice = input.renderDevice ?? DEFAULT_RENDER_DEVICE;
  const hasAudio = audio.action !== "none" && audio.streamIndex !== null;

  // "original" copies video exactly when the plan says the source codec
  // survives as-is; "remote" always re-encodes to a small H.264 rendition
  // regardless of the source -- video-playback.ts's buildHlsFfmpegArgs does
  // the same (its Remote branch never inspects plan.videoAction).
  const doVideoCopy = variant === "original" && plan.videoAction === "copy";
  const tenBit = (source.pixFmt ?? "").toLowerCase().includes("10");

  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error"];

  // Defense in depth: the source is always a database-resolved absolute
  // path, never a URL, so "file" is the only protocol -i itself needs;
  // "pipe" covers the segment-completion list below. Confirmed against a
  // real ffmpeg build that this is accepted as an input option and doesn't
  // disturb file-based segment output or the pipe-based list (see file
  // header).
  args.push("-protocol_whitelist", "file,pipe");

  // --- hardware decode setup (input options, before -i) ---
  if (!doVideoCopy && hwaccel !== "none") {
    // A 10-bit source can't be hardware-decoded on this generation of
    // iGPU (V4_PLAN.md, "Hardware: what HD Graphics 530 covers" -- HEVC
    // 10-bit decode needs Kaby Lake or later). Falling back to software
    // decode for just those frames, then uploading them for hardware
    // encode, is the documented workaround ("Hardware switch": "software
    // decode -> format=nv12,hwupload -> hardware encode"). The device is
    // still needed either way, since the *encoder* is always hardware.
    if (hwaccel === "vaapi") {
      if (!tenBit) args.push("-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi");
      args.push("-vaapi_device", renderDevice);
    } else {
      if (!tenBit) args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
      args.push("-qsv_device", renderDevice);
    }
  }

  // --- seeking (input options, before -i) ---
  if (N > 0) {
    const boundaryStart = segments[N].start;
    if (doVideoCopy) {
      const keyframes = input.keyframes ?? [];
      if (keyframes.length === 0) {
        throw new Error("keyframes are required to restart a copied-video head at startIndex > 0");
      }
      args.push("-noaccurate_seek", "-ss", formatSeconds(clampCopySeekTarget(boundaryStart, keyframes)));
    } else {
      // Transcoded video: an accurate seek (no -noaccurate_seek) puts the
      // first *encoded* frame exactly at the boundary -- there's no
      // keyframe grid to land on since this head is about to force one
      // there itself.
      args.push("-ss", formatSeconds(boundaryStart));
    }
  }

  args.push("-i", input.input);

  // --- stream selection ---
  args.push("-map", "0:v:0");
  if (hasAudio) args.push("-map", `0:${audio.streamIndex}`);
  args.push("-map_chapters", "-1", "-sn");

  // -copyts: see the file header -- this is what makes -force_key_frames's
  // absolute times below line up with the segment table. -avoid_negative_ts
  // disabled: don't let the muxer "fix" a negative start by shifting the
  // whole timeline -- with copyts, a negative offset from a seek is
  // expected, not an error to paper over.
  args.push("-copyts", "-avoid_negative_ts", "disabled", "-max_muxing_queue_size", "2048");

  // --- video ---
  if (doVideoCopy) {
    args.push("-c:v", "copy", "-bsf:v", annexBBitstreamFilter(plan.outputVideoCodec));
  } else {
    const futureBoundaries = futureBoundaryTimes(segments, N);

    if (hwaccel === "none") {
      const filters: string[] = [];
      if (source.interlaced) filters.push("yadif");
      // Never upscale a DVD source past its own height -- matches
      // buildHlsFfmpegArgs's Remote filter exactly (video-playback.ts).
      if (variant === "remote") filters.push("scale=-2:min(720\\,ih)");
      if (filters.length > 0) args.push("-vf", filters.join(","));

      args.push("-c:v", "libx264", "-preset", "veryfast");
      if (variant === "remote") {
        args.push("-crf", "23", "-maxrate", REMOTE_VIDEO_MAXRATE, "-bufsize", "6M");
      } else {
        args.push("-crf", "18");
      }
      args.push("-pix_fmt", "yuv420p", "-threads", "2");
      // Forced boundary keyframes only: a scene-cut keyframe just before a
      // boundary would be taken for the cut (see -segment_time_delta).
      args.push("-sc_threshold", "0", "-g", "600");
    } else {
      const filters: string[] = [];
      if (tenBit) filters.push("format=nv12", "hwupload");
      if (hwaccel === "vaapi") {
        if (source.interlaced) filters.push("deinterlace_vaapi");
        if (variant === "remote") filters.push("scale_vaapi=w=-2:h=min(720\\,ih)");
      } else {
        if (source.interlaced) filters.push("vpp_qsv=deinterlace=2");
        if (variant === "remote") filters.push("scale_qsv=w=-1:h=720");
      }
      if (filters.length > 0) args.push("-vf", filters.join(","));

      args.push("-c:v", hwaccel === "vaapi" ? "h264_vaapi" : "h264_qsv");
      args.push(...hwQualityArgs(hwaccel, variant));

      const gop = computeGop(source.fps);
      args.push("-g", String(gop), "-keyint_min", String(gop));
    }

    // Fixed GOP settings alone don't guarantee an exact boundary (a
    // variable-frame-rate source can drift), so every future boundary is
    // forced explicitly too -- belt and braces, matching the same pattern
    // buildHlsFfmpegArgs uses for its own segment grid.
    if (futureBoundaries.length > 0) args.push("-force_key_frames", futureBoundaries.join(","));
  }

  // --- audio ---
  if (hasAudio) {
    if (variant === "remote") {
      // Remote always re-encodes to a small, universally-compatible track,
      // whatever the source's chosen action was -- video-playback.ts's
      // buildHlsFfmpegArgs does the same for the event-playlist pipeline.
      args.push("-c:a", "aac", "-ac", "2", "-b:a", REMOTE_AUDIO_BITRATE);
    } else if (audio.action === "copy") {
      args.push("-c:a", "copy");
    } else {
      const outputChannels = audioTranscodeChannels(audio.sourceChannels);
      args.push("-c:a", "aac", "-ac", String(outputChannels), "-b:a", audioTranscodeBitrate(outputChannels));
    }
  }

  // --- segment muxer output (see the file header for the full contract) ---
  args.push("-f", "segment", "-segment_format", "mpegts");
  // The top-level -copyts above only governs the demux/decode/encode path;
  // the mpegts muxer has its *own* separate timestamp-rebasing switch
  // (`ffmpeg -h muxer=mpegts`: "-mpegts_copyts <boolean> don't offset
  // dts/pts (default auto)"), and its "auto" default still rebased the
  // first segment to start near a fixed ~1.4s offset in a real test here
  // rather than 0 -- confirmed against a real ffmpeg build (Homebrew
  // 9.0.2, 19 Sep 2026) by probing a produced segment's own first frame
  // pts. A bare top-level `-mpegts_copyts 1` does not reach the segment
  // muxer's per-file mpegts writer either; it has to be threaded through
  // as a segment-format option. With this, a restarted head's segment
  // carries the *same* absolute video PTS (verified: identical, frame for
  // frame) as the equivalent segment from a head that ran straight through
  // from 0 -- the "Heads" restart-consistency claim this file's contract
  // depends on.
  args.push("-segment_format_options", "mpegts_copyts=1");
  args.push("-segment_start_number", String(N));
  // The muxer cuts at the first keyframe whose pts, *relative to this
  // head's first video packet*, is >= cut - delta. For copied video the
  // first packet is the boundary keyframe itself, so a tight delta is
  // right (and necessary: real keyframes can be well under a second
  // apart). For transcoded video the first frame is NOT exactly on the
  // boundary -- a source whose first pts is 0.063, or an accurate seek
  // landing a frame late -- while the forced keyframes are on the absolute
  // grid, so with a tight delta the first cut is missed, segment N comes
  // out double length and every later file is numbered one too low (seen
  // on the VM, 19 Sep 2026: VC-1 from 0 and MPEG-2 from a cold seek). The
  // only keyframes a transcode contains are the forced ones, so a wide
  // delta is safe there.
  args.push("-segment_time_delta", doVideoCopy ? COPY_SEGMENT_TIME_DELTA : TRANSCODE_SEGMENT_TIME_DELTA, "-break_non_keyframes", "0");
  if (N < segments.length - 1) {
    args.push("-segment_times", relativeCutTimes(segments, N).join(","));
  }
  args.push("-segment_list", "pipe:1", "-segment_list_type", "csv", "-segment_list_flags", "live");
  args.push(`${outDir}/seg_%05d.ts`);

  return args;
}
