// Audio codec/channel-layout badge labelling. Direct-play is the whole point
// of this library (Infuse/Apple TV, no transcoding), so the badge needs to
// say exactly what's on disk: DTS-HD MA vs plain DTS, Dolby Digital vs Plus,
// not just "dts"/"ac3" verbatim from ffprobe.

/** The two object-audio formats, each layered on a lossless base codec:
 *  Atmos on TrueHD or DD+, DTS:X on DTS-HD MA. */
export type ObjectAudio = "atmos" | "dtsx";

export interface AudioBadgeInfo {
  label: string;
  sublabel: string | null;
  /** Object audio riding on top of the codec in `label`. ffprobe reports it
   *  in the profile, not the codec name ("Dolby TrueHD + Dolby Atmos",
   *  "DTS-HD MA + DTS:X"), and it's an addition to the base track rather
   *  than a replacement for it — a TrueHD Atmos track is still a TrueHD
   *  track to anything that can't decode the objects. So it stays separate
   *  from `label`, and the UI draws its mark *beside* the codec badge
   *  instead of relabelling it. */
  objectAudio: ObjectAudio | null;
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

// "DTS:X" as ffprobe spells it, tolerating the "DTS-X" / "DTS X" variants.
// Deliberately not a bare "X" test: the DTS Express profile would match one.
const DTS_X = /DTS[:\-\s]?X\b/;

function objectAudioIn(profile: string | null): ObjectAudio | null {
  const p = (profile ?? "").toUpperCase();
  if (p.includes("ATMOS")) return "atmos";
  if (DTS_X.test(p)) return "dtsx";
  return null;
}

// The base codec under a DTS profile. A DTS:X track names its core here too
// ("DTS-HD MA + DTS:X"), and that core is what this returns — the X rides
// alongside as objectAudio, so there's no "DTS:X" case to match.
function dtsLabel(profile: string | null): string {
  const p = (profile ?? "").toUpperCase();
  if (p.includes("MA")) return "DTS-HD MA";
  if (p.includes("HRA")) return "DTS-HD HRA";
  if (p.includes("ES")) return "DTS-ES";
  return "DTS";
}

/**
 * Map a raw ffprobe (codec, profile, channels, layout) tuple to a badge
 * label + channel-layout sublabel + object-audio rider for display.
 */
export function audioBadge(
  codec: string | null,
  profile: string | null,
  channels: number | null,
  layout: string | null,
): AudioBadgeInfo {
  const sublabel = normalizeLayout(layout) ?? layoutFromChannelCount(channels);
  const objectAudio = objectAudioIn(profile);

  if (!codec) {
    return { label: "Unknown", sublabel, objectAudio: null };
  }

  const c = codec.toLowerCase();

  if (c === "dts") {
    return { label: dtsLabel(profile), sublabel, objectAudio };
  }

  if (c.startsWith("pcm")) {
    return { label: "PCM", sublabel, objectAudio: null };
  }

  const known = CODEC_LABELS[c];
  if (known) {
    return { label: known, sublabel, objectAudio };
  }

  return { label: codec.toUpperCase(), sublabel, objectAudio };
}

// Which visual "family" a badge label belongs to, for the quiet Dolby-tint
// vs DTS-tint distinction in the UI (VersionCard). Anything else is neutral.
export type AudioFamily = "dolby" | "dts" | "neutral";

export function audioFamily(label: string): AudioFamily {
  if (label.startsWith("Dolby")) return "dolby";
  if (label.startsWith("DTS")) return "dts";
  return "neutral";
}

// Words a track name uses when it only restates what the chips already say.
const FORMAT_WORDS =
  /\b(surround|stereo|mono|dolby|digital|plus|truehd|true-hd|atmos|dts|hd|ma|master|audio|x|aac|ac3|eac3|e-ac-3|ac-3|flac|pcm|lpcm|lossless|channels?|ch)\b/g;

/** Whether a track's own name ("Surround 7.1", "Stereo", "DTS-HD MA 5.1")
 *  only repeats its codec and layout — shown beside the chips it would say
 *  everything twice. A name with anything else in it ("Commentary",
 *  "Director's commentary", "Audio description") is worth showing. */
export function titleRepeatsFormat(title: string): boolean {
  const rest = title
    .toLowerCase()
    .replace(FORMAT_WORDS, " ")
    .replace(/\d+(\.\d+)?/g, " ")
    .replace(/[\s:+\-.,/()[\]]+/g, "");
  return rest.length === 0;
}
