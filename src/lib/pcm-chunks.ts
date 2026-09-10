// Turns the raw PCM byte stream that /api/audio/<id> serves (see
// src/lib/audio-stream.ts: interleaved little-endian 16- or 24-bit
// samples, no container) into fixed-size planar Float32 chunks — the shape
// an AudioBuffer wants. Pure and framework-free so player-engine.ts's
// streaming loader stays thin and this can be unit-tested with hand-built
// byte arrays (pcm-chunks.test.ts).
//
// Why raw PCM and not FLAC/AAC over the wire: decodeAudioData only works on
// a *complete* file, which meant nothing could play until every byte of a
// track had arrived (and Safari's rejection of FLAC then forced a second,
// bigger WAV download on top). Raw PCM has no framing to decode — every
// byte that lands is immediately playable — so the engine can schedule the
// first half-second of a track while the rest is still downloading. The
// cost is bandwidth (~1.4 Mbit/s for 16-bit 44.1 kHz stereo), which is
// nothing on the LAN and fine on a 4G/5G phone.

export interface PcmStreamFormat {
  sampleRate: number;
  channels: number;
  bits: 16 | 24;
}

/** Response headers the audio route stamps on a PCM stream. Kept in one
 *  place so the server (audio-stream.ts) and this parser can't drift. */
export const PCM_HEADERS = {
  sampleRate: "x-audio-sample-rate",
  channels: "x-audio-channels",
  bits: "x-audio-bits",
  /** Total bytes the whole track *should* come to, from the DB's duration
   *  estimate — for a download-progress percentage, not exact. */
  estimatedBytes: "x-audio-estimated-bytes",
} as const;

export function parsePcmFormat(headers: Headers): PcmStreamFormat | null {
  const sampleRate = Number(headers.get(PCM_HEADERS.sampleRate));
  const channels = Number(headers.get(PCM_HEADERS.channels));
  const bits = Number(headers.get(PCM_HEADERS.bits));
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) return null;
  if (!Number.isInteger(channels) || channels <= 0) return null;
  if (bits !== 16 && bits !== 24) return null;
  return { sampleRate, channels, bits };
}

export function parseEstimatedBytes(headers: Headers): number | null {
  const n = Number(headers.get(PCM_HEADERS.estimatedBytes));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One chunk's samples: one Float32Array per channel, all the same length. */
export type PcmChunk = Float32Array[];

function decodeFrames(bytes: Uint8Array, frames: number, format: PcmStreamFormat): PcmChunk {
  const { channels, bits } = format;
  const planes: Float32Array[] = [];
  for (let c = 0; c < channels; c++) planes.push(new Float32Array(frames));
  let i = 0;
  if (bits === 16) {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        // Little-endian int16, sign-extended via the <<16>>16 trick.
        const v = ((bytes[i] | (bytes[i + 1] << 8)) << 16) >> 16;
        planes[c][f] = v / 32768;
        i += 2;
      }
    }
  } else {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        const v = ((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) << 8) >> 8;
        planes[c][f] = v / 8388608;
        i += 3;
      }
    }
  }
  return planes;
}

/**
 * Accumulates arbitrary-sized byte slices (whatever fetch's reader hands
 * over) and emits whole chunks of exactly `chunkFrames` frames; a trailing
 * partial frame is carried over to the next push, and flush() drains
 * whatever is left (shorter than a chunk) once the stream ends.
 */
export class PcmChunker {
  private readonly bytesPerFrame: number;
  private readonly chunkBytes: number;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly format: PcmStreamFormat,
    chunkFrames: number,
  ) {
    if (!Number.isInteger(chunkFrames) || chunkFrames <= 0) throw new Error("chunkFrames must be a positive integer");
    this.bytesPerFrame = format.channels * (format.bits / 8);
    this.chunkBytes = chunkFrames * this.bytesPerFrame;
  }

  push(bytes: Uint8Array): PcmChunk[] {
    let buf: Uint8Array;
    if (this.pending.length === 0) {
      buf = bytes;
    } else {
      buf = new Uint8Array(this.pending.length + bytes.length);
      buf.set(this.pending, 0);
      buf.set(bytes, this.pending.length);
    }
    const chunks: PcmChunk[] = [];
    let offset = 0;
    while (buf.length - offset >= this.chunkBytes) {
      chunks.push(decodeFrames(buf.subarray(offset, offset + this.chunkBytes), this.chunkBytes / this.bytesPerFrame, this.format));
      offset += this.chunkBytes;
    }
    // Copy (not subarray) so we don't pin the whole network buffer alive
    // for the sake of a few leftover bytes.
    this.pending = buf.slice(offset);
    return chunks;
  }

  flush(): PcmChunk | null {
    const frames = Math.floor(this.pending.length / this.bytesPerFrame);
    const chunk = frames > 0 ? decodeFrames(this.pending, frames, this.format) : null;
    this.pending = new Uint8Array(0);
    return chunk;
  }
}
