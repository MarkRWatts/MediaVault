// Pure playback-decision logic for in-app video playback (Safari/iPadOS/iOS
// first — see the research doc for the full device/codec survey). Mirrors
// audio-stream.ts's resolvePlaybackFormat in spirit: no I/O, no ffmpeg, no
// Prisma — just codec/container in, a plan out, so it's cheap to test
// exhaustively.
//
// Three tiers collapse to two operationally:
//   - "direct": the file is already a browser-playable MP4 — serve the
//     original bytes untouched (see video-stream.ts).
//   - "prepare": something needs fixing (container, audio codec, or video
//     codec) — run ffmpeg once into a cached MP4, then serve *that* the same
//     way. Remux-only and full-transcode are both this tier; they only differ
//     in which ffmpeg args get used (see buildFfmpegArgs).
//
// A Blu-ray remux's video (H.264/HEVC) almost always survives as a copy; only
// DVD-era MPEG-2/VC-1 needs a real re-encode. Audio prefers an existing
// AAC/AC-3/E-AC-3 track (copy, free) and only transcodes when the only tracks
// present are lossless-but-unsupported (TrueHD/DTS/DTS-HD MA/PCM) — in which
// case it transcodes the *best* of those (highest channel count, preferring a
// lossless source) rather than whichever track happens to be first.

export type VideoPlaybackTier = "direct" | "prepare";
export type StreamAction = "copy" | "transcode";

export interface AudioTrackInput {
  streamIdx: number;
  codec: string | null;
  profile: string | null;
  channels: number | null;
}

export interface VideoPlaybackInput {
  videoCodec: string | null;
  container: string | null;
  audioTracks: AudioTrackInput[];
}

export interface VideoPlaybackPlan {
  tier: VideoPlaybackTier;
  videoAction: StreamAction;
  /** ffprobe's absolute stream index (Version/AudioTrack.streamIdx) for the
   *  chosen audio track — used as `-map 0:<n>`. null when the file has no
   *  audio streams at all (still plays fine, just silent). */
  audioStreamIndex: number | null;
  audioAction: StreamAction | "none";
  /** Apply `-tag:v hvc1` when muxing HEVC into MP4 — the default `hev1` tag
   *  is unreliable for Apple's own players/Safari. */
  hevcTag: boolean;
  reason: string;
}

const SUPPORTED_VIDEO_CODECS = new Set(["h264", "hevc", "h265"]);
const HEVC_CODECS = new Set(["hevc", "h265"]);
const MP4_LIKE_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const COMPATIBLE_AUDIO_CODECS = new Set(["aac", "ac3", "eac3"]);

// Sources worth transcoding *from* preferentially when no compatible track
// exists — a lossless origin gives the best possible AAC result. Plain
// DTS/AC-3 cores are already lossy, so there's no quality reason to prefer
// them over, say, a higher-channel-count PCM track.
function isLosslessSource(codec: string | null, profile: string | null): boolean {
  const c = (codec ?? "").toLowerCase();
  if (c === "truehd") return true;
  if (c.startsWith("pcm")) return true;
  if (c === "dts" && (profile ?? "").toUpperCase().includes("MA")) return true;
  return false;
}

function pickAudioTrack(tracks: AudioTrackInput[]): { index: number; action: StreamAction } | null {
  if (tracks.length === 0) return null;

  const byIdx = [...tracks].sort((a, b) => a.streamIdx - b.streamIdx);
  const compatible = byIdx.find((t) => COMPATIBLE_AUDIO_CODECS.has((t.codec ?? "").toLowerCase()));
  if (compatible) return { index: compatible.streamIdx, action: "copy" };

  // Nothing directly playable — transcode the best candidate: most channels,
  // tie-broken toward a lossless source.
  const scored = byIdx.map((t) => ({
    track: t,
    score: (t.channels ?? 0) * 10 + (isLosslessSource(t.codec, t.profile) ? 5 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return { index: scored[0].track.streamIdx, action: "transcode" };
}

/**
 * Decide how to serve one Version. Returns null when the file hasn't been
 * probed yet (no videoCodec on record) — callers should treat that as "not
 * ready" rather than guessing.
 */
export function planVideoPlayback(input: VideoPlaybackInput): VideoPlaybackPlan | null {
  if (!input.videoCodec) return null;

  const videoCodec = input.videoCodec.toLowerCase();
  const container = (input.container ?? "").toLowerCase();
  const videoOk = SUPPORTED_VIDEO_CODECS.has(videoCodec);
  const videoAction: StreamAction = videoOk ? "copy" : "transcode";

  const audioChoice = pickAudioTrack(input.audioTracks);
  const audioStreamIndex = audioChoice ? audioChoice.index : null;
  const audioAction: StreamAction | "none" = audioChoice ? audioChoice.action : "none";

  const canDirectPlay =
    videoAction === "copy" && audioAction !== "transcode" && MP4_LIKE_CONTAINERS.has(container);

  const hevcTag = videoAction === "copy" && HEVC_CODECS.has(videoCodec);

  if (canDirectPlay) {
    return {
      tier: "direct",
      videoAction,
      audioStreamIndex,
      audioAction,
      hevcTag,
      reason: `${videoCodec} in .${container || "?"} with ${audioAction === "none" ? "no audio" : "a compatible audio track"} — already playable`,
    };
  }

  const reasons: string[] = [];
  if (!MP4_LIKE_CONTAINERS.has(container)) reasons.push(`container .${container || "?"} needs remuxing`);
  if (!videoOk) reasons.push(`video codec ${videoCodec} needs transcoding`);
  if (audioAction === "transcode") reasons.push("audio has no directly-playable track");

  return {
    tier: "prepare",
    videoAction,
    audioStreamIndex,
    audioAction,
    hevcTag,
    reason: reasons.join("; ") || "needs preparation",
  };
}

// Simple per-channel-count AAC bitrate — generous enough that the transcode
// isn't the bottleneck on quality, capped at 6 channels (5.1) since
// multichannel AAC beyond that is a much shakier bet on Apple's own decoders.
export function audioTranscodeChannels(sourceChannels: number | null): number {
  if (!sourceChannels || sourceChannels <= 2) return sourceChannels ?? 2;
  return Math.min(sourceChannels, 6);
}

export function audioTranscodeBitrate(outputChannels: number): string {
  if (outputChannels <= 2) return "192k";
  if (outputChannels <= 6) return "384k";
  return "512k";
}

/**
 * Build the ffmpeg argument list for a "prepare" job. `output` is an absolute
 * path ffmpeg should write to directly (already resolved for local-vs-docker
 * by the caller — see video-cache.ts). `sourceAudioChannels` is only needed
 * when `plan.audioAction === "transcode"`, to size the AAC output.
 */
export function buildFfmpegArgs(
  input: string,
  output: string,
  plan: VideoPlaybackPlan,
  sourceAudioChannels?: number | null,
): string[] {
  const args = ["-y", "-i", input, "-map", "0:v:0"];

  if (plan.audioStreamIndex !== null) {
    args.push("-map", `0:${plan.audioStreamIndex}`);
  }

  // Drop chapters explicitly. Without this, the mov/mp4 muxer auto-converts
  // any source chapter markers into an extra QuickTime chapter text track --
  // harmless in a normal MP4, but in this fragmented output (required for the
  // tailing reader, see below) the stray trak breaks playback outright:
  // confirmed against a real file (chapters present, no subtitle stream) that
  // Safari reports a duration but never renders a single video or audio frame
  // once this extra track is present.
  args.push("-map_chapters", "-1");

  if (plan.videoAction === "copy") {
    args.push("-c:v", "copy");
    if (plan.hevcTag) args.push("-tag:v", "hvc1");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  }

  if (plan.audioStreamIndex !== null) {
    if (plan.audioAction === "copy") {
      args.push("-c:a", "copy");
    } else {
      const outputChannels = audioTranscodeChannels(sourceAudioChannels ?? null);
      args.push("-c:a", "aac", "-ac", String(outputChannels), "-b:a", audioTranscodeBitrate(outputChannels));
    }
  }

  // Fragmented MP4, not +faststart: faststart writes the moov (index) only
  // after the whole mdat exists, then seeks back to prepend it -- a partial
  // file isn't valid to play until that second pass, right near the end.
  // Fragmented output writes a minimal moov immediately, then a sequence of
  // self-contained moof+mdat fragments, so a reader can start decoding from
  // whatever's been written so far -- what makes streaming while the file is
  // still being generated possible at all (see video-cache.ts's tailing
  // reader).
  //
  // delay_moov is required, not optional, whenever an audio track is
  // stream-copied: the mp4 muxer needs to know each stream's frame size to
  // write even an empty moov, and a copied (not re-encoded) AC-3 track
  // doesn't expose that until its first packet arrives -- without this flag,
  // copying AC-3 audio fails outright ("Cannot write moov atom before AC3
  // packets"), confirmed against a real file. Harmless to always include.
  args.push("-movflags", "frag_keyframe+empty_moov+delay_moov+default_base_moof", "-f", "mp4", output);
  return args;
}
