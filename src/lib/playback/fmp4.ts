// Fragmented-MP4 segments for copied HEVC (decisions.ts's
// segmentContainerFor). A head's segment muxer writes each segment as a
// complete fragmented MP4 -- `ftyp`, `moov`, then `moof`/`mdat` pairs --
// because it opens a fresh MP4 writer per file. HLS wants the `ftyp`+`moov`
// once, as the playlist's EXT-X-MAP (`init.mp4`), and each media segment as
// the rest. So promotion splits the file: the first segment of a stream
// leaves its `ftyp`+`moov` behind as `init.mp4`, and every segment is
// renamed in as its `moof`/`mdat` alone.
//
// One init serves every segment of a stream, whichever head wrote it: the
// `ftyp`+`moov` a head writes is byte-identical at the film's start and 600
// s in (checked against Man of Steel's UHD file, 24 Sep 2026) -- with
// `empty_moov` it holds only track setup, no samples. And each fragment's
// `tfdt` is the source's own absolute decode time (head-args.ts's
// `avoid_negative_ts=disabled` for the per-segment writer), so segments
// from different heads line up on one timeline, exactly as the MPEG-TS
// ones do with `mpegts_copyts`.

import { promises as fs } from "node:fs";
import path from "node:path";

export const INIT_SEGMENT_NAME = "init.mp4";

const HEADER_BOXES = new Set(["ftyp", "moov"]);

interface Box {
  type: string;
  start: number;
  end: number;
}

/** The top-level boxes of an MP4 file, in order. Throws on a file that
 *  doesn't parse cleanly to its end -- a truncated segment must not be
 *  served as a whole one. */
export function topLevelBoxes(bytes: Buffer): Box[] {
  const boxes: Box[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error(`truncated box header at ${at}`);
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > bytes.length) throw new Error(`truncated large box header at ${at}`);
      size = Number(bytes.readBigUInt64BE(at + 8));
    } else if (size === 0) {
      size = bytes.length - at;
    }
    if (size < 8 || at + size > bytes.length) throw new Error(`box ${type} at ${at} runs past the end`);
    boxes.push({ type, start: at, end: at + size });
    at += size;
  }
  return boxes;
}

/** A head's whole-file segment split into its header (`ftyp`+`moov`) and
 *  its media (everything else, `moof`/`mdat`). */
export function splitSegment(bytes: Buffer): { header: Buffer; media: Buffer } {
  const boxes = topLevelBoxes(bytes);
  const pick = (want: boolean) =>
    Buffer.concat(boxes.filter((b) => HEADER_BOXES.has(b.type) === want).map((b) => bytes.subarray(b.start, b.end)));
  const header = pick(true);
  const media = pick(false);
  if (!boxes.some((b) => b.type === "moov")) throw new Error("segment has no moov");
  if (!boxes.some((b) => b.type === "moof")) throw new Error("segment has no moof");
  return { header, media };
}

/** Boxes directly inside `[start, end)`. */
function childBoxes(bytes: Buffer, start: number, end: number): Box[] {
  return topLevelBoxes(bytes.subarray(start, end)).map((b) => ({ ...b, start: b.start + start, end: b.end + start }));
}

function headerSize(bytes: Buffer, box: Box): number {
  return bytes.readUInt32BE(box.start) === 1 ? 16 : 8;
}

/** Each track's id, handler ("vide", "soun") and timescale, from a moov. */
export function trackInfo(header: Buffer): Map<number, { handler: string; timescale: number }> {
  const tracks = new Map<number, { handler: string; timescale: number }>();
  const moov = topLevelBoxes(header).find((b) => b.type === "moov");
  if (!moov) return tracks;
  for (const trak of childBoxes(header, moov.start + headerSize(header, moov), moov.end)) {
    if (trak.type !== "trak") continue;
    const inner = childBoxes(header, trak.start + 8, trak.end);
    const tkhd = inner.find((b) => b.type === "tkhd");
    const mdia = inner.find((b) => b.type === "mdia");
    if (!tkhd || !mdia) continue;
    const tkhdVersion = header[tkhd.start + 8];
    const id = header.readUInt32BE(tkhd.start + 8 + (tkhdVersion === 1 ? 20 : 12));
    const mdiaInner = childBoxes(header, mdia.start + 8, mdia.end);
    const mdhd = mdiaInner.find((b) => b.type === "mdhd");
    const hdlr = mdiaInner.find((b) => b.type === "hdlr");
    if (!mdhd || !hdlr) continue;
    const mdhdVersion = header[mdhd.start + 8];
    const timescale = header.readUInt32BE(mdhd.start + 8 + (mdhdVersion === 1 ? 20 : 12));
    tracks.set(id, { handler: header.toString("latin1", hdlr.start + 16, hdlr.start + 20), timescale });
  }
  return tracks;
}

export interface TrackFragment {
  trackId: number;
  /** Offset of the tfdt's decode-time field, and its width. */
  tfdtAt: number;
  tfdtBytes: 4 | 8;
  decodeTime: bigint;
  /** The first sample's composition offset, 0 when the trun carries none. */
  firstCto: number;
}

/** Every track fragment's decode time and first composition offset, in
 *  file order. Exported for tests. */
export function trackFragments(media: Buffer): TrackFragment[] {
  const out: TrackFragment[] = [];
  for (const moof of topLevelBoxes(media)) {
    if (moof.type !== "moof") continue;
    for (const traf of childBoxes(media, moof.start + 8, moof.end)) {
      if (traf.type !== "traf") continue;
      const inner = childBoxes(media, traf.start + 8, traf.end);
      const tfhd = inner.find((b) => b.type === "tfhd");
      const tfdt = inner.find((b) => b.type === "tfdt");
      const trun = inner.find((b) => b.type === "trun");
      if (!tfhd || !tfdt) continue;
      const trackId = media.readUInt32BE(tfhd.start + 12);
      const wide = media[tfdt.start + 8] === 1;
      const tfdtAt = tfdt.start + 12;
      // Signed on purpose: ffmpeg writes a first audio fragment primed before
      // zero as a wrapped negative (see alignAudioToVideo).
      const decodeTime = wide ? media.readBigInt64BE(tfdtAt) : BigInt(media.readUInt32BE(tfdtAt));
      let firstCto = 0;
      if (trun) {
        const version = media[trun.start + 8];
        const flags = media.readUIntBE(trun.start + 9, 3);
        const count = media.readUInt32BE(trun.start + 12);
        let at = trun.start + 16;
        if (flags & 0x1) at += 4; // data offset
        if (flags & 0x4) at += 4; // first sample flags
        if (flags & 0x100) at += 4; // duration
        if (flags & 0x200) at += 4; // size
        if (flags & 0x400) at += 4; // flags
        if (count > 0 && flags & 0x800) firstCto = version === 0 ? media.readUInt32BE(at) : media.readInt32BE(at);
      }
      out.push({ trackId, tfdtAt, tfdtBytes: wide ? 8 : 4, decodeTime, firstCto });
    }
  }
  return out;
}

/**
 * Put a segment's audio back in step with its picture. The per-file MP4
 * writer can't give video a decode time before zero, so a source whose
 * first frame decodes before it is shown (B-frames: Man of Steel's first
 * keyframe shows at 0 and decodes at -0.042) comes out with every video
 * frame one reorder-delay late -- 42 ms, the same in every segment -- while
 * the audio keeps the source's times. `keyframeStart` is where the
 * segment's first frame really shows (the segment table's start, a source
 * keyframe), so the delay is measured, not assumed, and the audio moved by
 * it. Moving audio rather than video keeps every decode time positive.
 * Rewrites `media` in place; returns the shift, in seconds.
 */
export function alignAudioToVideo(media: Buffer, tracks: Map<number, { handler: string; timescale: number }>, keyframeStart: number): number {
  const fragments = trackFragments(media);
  const video = fragments.find((f) => tracks.get(f.trackId)?.handler === "vide");
  if (!video) return 0;
  const videoScale = tracks.get(video.trackId)!.timescale;
  const shownAt = (Number(video.decodeTime) + video.firstCto) / videoScale;
  const lag = shownAt - keyframeStart;
  // Only a reorder delay: well under a second, and later rather than earlier.
  if (!(lag > 0.0005 && lag < 1)) return 0;
  for (const f of fragments) {
    const track = tracks.get(f.trackId);
    if (track?.handler !== "soun") continue;
    // AAC priming puts a film's first audio a little before zero (Man of
    // Steel: -0.044 s, -0.002 s once moved). A decode time is unsigned, so
    // that would be read as the far future; start it at zero instead -- a
    // couple of milliseconds, once, at the very start of the film.
    const shifted = f.decodeTime + BigInt(Math.round(lag * track.timescale));
    const moved = shifted < BigInt(0) ? BigInt(0) : shifted;
    if (f.tfdtBytes === 8) media.writeBigUInt64BE(moved, f.tfdtAt);
    else if (moved >= BigInt(0) && moved <= BigInt(0xffffffff)) media.writeUInt32BE(Number(moved), f.tfdtAt);
  }
  return lag;
}

/**
 * The RFC 6381 CODECS value for an init segment's HEVC track, read from its
 * `hvcC` exactly (ISO/IEC 14496-15 Annex E): e.g. Man of Steel's 4K file is
 * `hvc1.2.4.H153.90` -- Main 10, High tier, level 5.1 -- which no rule of
 * thumb built from pixel format and height gets right. Null when the init
 * has no `hvcC`.
 */
export function hevcCodecFromInit(init: Buffer): string | null {
  const at = init.indexOf("hvcC", 0, "latin1");
  if (at < 4 || at + 4 + 13 > init.length) return null;
  const c = init.subarray(at + 4);
  const profileSpace = c[1] >> 6;
  const tier = (c[1] >> 5) & 1;
  const profileIdc = c[1] & 0x1f;
  // The 32 compatibility flags, written bit-reversed, in hex.
  const flags = c.readUInt32BE(2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) if (flags & (1 << bit)) reversed |= 1 << (31 - bit);
  const constraints = [...c.subarray(6, 12)].map((b) => b.toString(16).toUpperCase());
  while (constraints.length > 0 && constraints[constraints.length - 1] === "0") constraints.pop();
  const level = c[12];
  const space = profileSpace === 0 ? "" : "ABC"[profileSpace - 1];
  return [`hvc1.${space}${profileIdc}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier ? "H" : "L"}${level}`, ...constraints].join(".");
}

/**
 * Promote one staged fMP4 segment into `target` as media only, first saving
 * its header as the stream's `init.mp4` if there isn't one yet, and with its
 * audio aligned to its picture (alignAudioToVideo; `keyframeStart` is the
 * segment table's start for it). Both files land by rename from a temporary
 * name, so a reader never sees half a file. The staged file is removed
 * either way.
 */
export async function promoteFragmentedSegment(staged: string, target: string, keyframeStart: number): Promise<void> {
  const { header, media } = splitSegment(await fs.readFile(staged));
  alignAudioToVideo(media, trackInfo(header), keyframeStart);
  const dir = path.dirname(target);
  const initPath = path.join(dir, INIT_SEGMENT_NAME);
  try {
    await fs.access(initPath);
  } catch {
    const tmpInit = `${initPath}.${process.pid}.tmp`;
    await fs.writeFile(tmpInit, header);
    await fs.rename(tmpInit, initPath);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, media);
  await fs.rename(tmp, target);
  await fs.unlink(staged).catch(() => {});
}
