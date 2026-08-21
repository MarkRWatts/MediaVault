// Pure helper: derives the small "quality" string shown as AudioCodecBadge's
// second segment (e.g. "16/44.1" for a lossless track, "~320k" for a lossy
// one). Two unrelated notions of "quality" depending on codec family, and
// none at all for DRM/unrecognised codecs — see SPEC-MUSIC.md "Quality
// badges (Worker F, follow-up)".

export interface QualityInput {
  codec: string | null | undefined;
  lossless: boolean;
  sampleRate: number | null | undefined;
  bitDepth: number | null | undefined;
  sizeBytes: number | null | undefined;
  durationSecs: number | null | undefined;
}

const LOSSLESS_CODECS = new Set(["alac", "flac"]);
const LOSSY_CODECS = new Set(["mp3", "aac"]);

// Sample rates in the wild (44100, 48000, 88200, 96000, ...) are all
// multiples of 100 Hz, so one decimal place is always enough to represent
// them exactly: 44100 -> "44.1", 48000 -> "48", 88200 -> "88.2".
function formatKhz(hz: number): string {
  const khz = Math.round((hz / 1000) * 10) / 10;
  return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}

/**
 * "16/44.1" for lossless tracks (bitDepth / sampleRate-in-kHz, trailing
 * zeros dropped; null if either field is missing), "~320k" for lossy tracks
 * (average kbps from sizeBytes*8/durationSecs/1000, rounded to the nearest
 * 16; null if not computable), null for DRM or any other/unrecognised
 * codec.
 */
export function qualityLabel(input: QualityInput): string | null {
  const codec = (input.codec ?? "").toLowerCase();

  if (input.lossless && LOSSLESS_CODECS.has(codec)) {
    if (input.bitDepth == null || input.sampleRate == null) return null;
    return `${input.bitDepth}/${formatKhz(input.sampleRate)}`;
  }

  if (!input.lossless && LOSSY_CODECS.has(codec)) {
    if (input.sizeBytes == null || input.durationSecs == null || input.durationSecs <= 0) {
      return null;
    }
    const kbps = (input.sizeBytes * 8) / input.durationSecs / 1000;
    const rounded = Math.round(kbps / 16) * 16;
    return rounded > 0 ? `~${rounded}k` : null;
  }

  return null; // drm / unknown / unrecognised codec
}
