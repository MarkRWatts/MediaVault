// The small format badges in a film's metadata line — resolution, HDR and
// the soundtrack's channels — read off the copy that would play. The same
// rules as the iOS and Apple TV apps (MediaVaultKit's VideoBadges), so every
// app says the same thing about a film:
//
// - resolution by width, as resolutionTier does: a scope Blu-ray is
//   1920×800, which by height alone would read as less than HD;
// - "HDR", or "Dolby Vision" by name; nothing for SDR;
// - channels as heard: a track every app plays directly counts as it is; a
//   TrueHD or DTS one is converted by the playback engine to AAC of at most
//   5.1 (head-args.ts, -ac 6), so it counts for no more than that. A disc
//   with AAC 5.1 beside TrueHD Atmos 7.1 is 5.1 whichever track plays.

export interface BadgeTrack {
  codec: string | null;
  channels: number | null;
}

export interface BadgeSource {
  width: number | null;
  height: number | null;
  videoRange: string | null;
  audioTracks: BadgeTrack[];
}

const UNPLAYABLE_AUDIO = new Set(["truehd", "mlp", "dts", "dca"]);
/** What the engine's audio conversion gives at most (-ac 6). */
const CONVERTED_MAX_CHANNELS = 6;

export function resolutionBadge(width: number | null, height: number | null): string | null {
  if (width && width > 0) {
    if (width >= 3000) return "Ultra HD";
    if (width >= 1100) return "HD";
    return "SD";
  }
  if (!height || height <= 0) return null;
  return height >= 1600 ? "Ultra HD" : height >= 700 ? "HD" : "SD";
}

export function channelBadge(channels: number): string | null {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo 2.0";
  if (channels === 6) return "Surround 5.1";
  if (channels === 7) return "Surround 6.1";
  if (channels >= 8) return "Surround 7.1";
  return null;
}

export function videoBadges(source: BadgeSource): string[] {
  const out: string[] = [];
  const resolution = resolutionBadge(source.width, source.height);
  if (resolution) out.push(resolution);
  const range = (source.videoRange ?? "").toUpperCase();
  if (range && range !== "SDR") {
    out.push(range.includes("DOVI") || range.includes("DOLBY") ? "Dolby Vision" : "HDR");
  }
  const heard = source.audioTracks.map((t) => {
    const channels = t.channels ?? 0;
    return UNPLAYABLE_AUDIO.has((t.codec ?? "").toLowerCase()) ? Math.min(channels, CONVERTED_MAX_CHANNELS) : channels;
  });
  const channels = heard.length ? Math.max(...heard) : 0;
  const label = channels > 0 ? channelBadge(channels) : null;
  if (label) out.push(label);
  return out;
}
