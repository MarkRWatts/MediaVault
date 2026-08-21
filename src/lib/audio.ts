// Audio codec/channel-layout badge labelling. Direct-play is the whole point
// of this library (Infuse/Apple TV, no transcoding), so the badge needs to
// say exactly what's on disk: DTS-HD MA vs plain DTS, Dolby Digital vs Plus,
// not just "dts"/"ac3" verbatim from ffprobe.

export interface AudioBadgeInfo {
  label: string;
  sublabel: string | null;
}

const CODEC_LABELS: Record<string, string> = {
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  aac: "AAC",
  flac: "FLAC",
  mp3: "MP3",
  mp2: "MP2",
  opus: "Opus",
  vorbis: "Vorbis",
};

// Channel count -> layout sublabel, used only when ffprobe's channel_layout
// tag isn't a recognised name (it usually is, but this is a safe fallback).
function layoutFromChannelCount(channels: number | null): string | null {
  if (channels == null) return null;
  switch (channels) {
    case 1:
      return "Mono";
    case 2:
      return "Stereo";
    case 6:
      return "5.1";
    case 7:
      return "6.1";
    case 8:
      return "7.1";
    default:
      return `${channels}ch`;
  }
}

// Normalise ffprobe's channel_layout tag ("5.1(side)", "stereo", "5.1(side,back)")
// into the short forms used in the UI.
function normalizeLayout(layout: string | null): string | null {
  if (!layout) return null;
  const base = layout.split("(")[0].trim().toLowerCase();
  switch (base) {
    case "mono":
      return "Mono";
    case "stereo":
      return "Stereo";
    case "5.1":
      return "5.1";
    case "6.1":
      return "6.1";
    case "7.1":
      return "7.1";
    case "2.1":
      return "2.1";
    case "quad":
      return "Quad";
    default:
      return base ? base.toUpperCase() : null;
  }
}

function dtsLabel(profile: string | null): string {
  const p = (profile ?? "").toUpperCase();
  if (p.includes("MA")) return "DTS-HD MA";
  if (p.includes("HRA")) return "DTS-HD HRA";
  if (p.includes("ES")) return "DTS-ES";
  if (p.includes("X")) return "DTS:X";
  return "DTS";
}

/**
 * Map a raw ffprobe (codec, profile, channels, layout) tuple to a badge
 * label + channel-layout sublabel for display.
 */
export function audioBadge(
  codec: string | null,
  profile: string | null,
  channels: number | null,
  layout: string | null,
): AudioBadgeInfo {
  const sublabel = normalizeLayout(layout) ?? layoutFromChannelCount(channels);

  if (!codec) {
    return { label: "Unknown", sublabel };
  }

  const c = codec.toLowerCase();

  if (c === "dts") {
    return { label: dtsLabel(profile), sublabel };
  }

  if (c.startsWith("pcm")) {
    return { label: "PCM", sublabel };
  }

  const known = CODEC_LABELS[c];
  if (known) {
    return { label: known, sublabel };
  }

  return { label: codec.toUpperCase(), sublabel };
}

// Which visual "family" a badge label belongs to, for the quiet Dolby-tint
// vs DTS-tint distinction in the UI (VersionCard). Anything else is neutral.
export type AudioFamily = "dolby" | "dts" | "neutral";

export function audioFamily(label: string): AudioFamily {
  if (label.startsWith("Dolby")) return "dolby";
  if (label.startsWith("DTS")) return "dts";
  return "neutral";
}
